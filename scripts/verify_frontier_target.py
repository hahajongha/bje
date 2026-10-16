#!/usr/bin/env python3
"""Independent frontierTarget validation against SciPy convex optimization.

Run from any working directory: python scripts/verify_frontier_target.py
Requires NumPy, SciPy, and Node.js, as does verify_allocation.py.

Seed 711038 creates 24 positive-definite seven-asset CMA/SAA fixtures. For each,
three source portfolios and two projection modes yield 144 checks. The sources
include a feasible anchor and asset vertices which may violate the SAA bands.
SciPy solves the variance cap or return floor directly, without using JavaScript
frontier points or the helper's root search. Line-search failures in the oracle
are retried using trust-constr followed by SLSQP refinement. Comparison includes
unavailable/non-dominating destinations and the weight-change identity.

This deterministic numerical check is not a proof for all possible inputs.
"""
import json
from pathlib import Path
import subprocess
import numpy as np
from scipy.optimize import linprog, minimize, LinearConstraint, NonlinearConstraint, Bounds

ROOT = Path(__file__).resolve().parents[1]
rng = np.random.default_rng(711038)
fixtures = []
groups = ['bond'] * 4 + ['equity'] * 2 + ['alternative']
for ix in range(24):
    n = 7
    raw = rng.normal(size=(n, n))
    cov = raw @ raw.T + np.eye(n) * 3
    vol = rng.uniform(2, 25, n)
    cov = cov / np.sqrt(np.outer(np.diag(cov), np.diag(cov))) * np.outer(vol, vol)
    means = rng.uniform(-4, 12, n)
    anchor = rng.dirichlet(np.ones(n) * 2)
    bounds = [{'min': float(max(0, x - rng.uniform(.08, .2))), 'max': float(min(1, x + rng.uniform(.08, .25)))} for x in anchor]
    gp = {}
    for group in ['bond', 'equity', 'alternative']:
        value = sum(anchor[j] for j in range(n) if groups[j] == group)
        gap = rng.uniform(.04, .25)
        gp[group] = {'min': float(max(0, value-gap)), 'max': float(min(1, value+gap))}
    if ix % 6 == 0:
        value = float(sum(anchor[:4]))
        gp['bond'] = {'min': value, 'max': value}
    fixtures.append({'assets': [{'mu':float(means[j]), 'vol':float(vol[j]), 'group':groups[j]} for j in range(n)],
        'cov':cov.tolist(), 'rf':1.5, 'policy':{'bounds':bounds, 'groups':gp},
        'sources': [anchor.tolist(), np.eye(n)[int(np.argmin(vol))].tolist(), np.eye(n)[int(np.argmax(means))].tolist()],
        'anchor':anchor.tolist()})

js = '''
import fs from 'node:fs';
import { stats } from './dist/portfolio.mjs';
import { optimizeAllocation } from './dist/allocation.mjs';
import { frontierTarget } from './dist/frontier-target.mjs';
const fixtures = JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(fixtures.map((f, index) => {
  try {
    const optimized = optimizeAllocation(f.assets, f.cov, f.rf, null, f.policy);
    return f.sources.map(w => {
      const selected = stats(w, f.assets, f.cov, f.rf);
      return Object.fromEntries(['same-risk','same-return'].map(mode => [mode,
        frontierTarget({selected, assets:f.assets, cov:f.cov, rf:f.rf, policy:f.policy, optimized, mode})]));
    });
  } catch (error) { return {error:error.message, index}; }
})));
'''
done = subprocess.run(['node', '--input-type=module', '-e', js],input=json.dumps(fixtures),text=True,capture_output=True,cwd=ROOT)
if done.returncode:
    raise RuntimeError(done.stderr)
results = json.loads(done.stdout)

maximum = {'same-risk_return_pct_points':0, 'same-return_variance_pct_points_squared':0, 'weight_change_identity':0, 'mu_identity':0, 'variance_identity':0}
checked = unavailable = oracle_trust_fallbacks = 0
for ix, (f, actual) in enumerate(zip(fixtures, results)):
    assert not isinstance(actual, dict), (ix, actual)
    cov = np.array(f['cov']); means = np.array([a['mu'] for a in f['assets']]); n=len(means)
    scale = np.max(np.diag(cov)); anchor=np.array(f['anchor'])
    bounds = [(b['min'],b['max']) for b in f['policy']['bounds']]
    eq = [(np.ones(n), 1.)]; ub=[]
    for name, b in f['policy']['groups'].items():
        a=np.array([float(g==name) for g in groups])
        if b['min']==b['max']: eq.append((a,b['min']))
        else: ub.extend([(a,b['max']),(-a,-b['min'])])
    constraints = [{'type':'eq','fun':lambda w,a=a,b=b: a@w-b,'jac':lambda w,a=a:a} for a,b in eq]
    constraints += [{'type':'ineq','fun':lambda w,a=a,b=b:b-a@w,'jac':lambda w,a=a:-a} for a,b in ub]
    objective=lambda w: float(w@cov@w)/scale
    gradient=lambda w: 2*cov@w/scale
    minvol = minimize(objective,anchor, jac=gradient,method='SLSQP',bounds=bounds,constraints=constraints,options={'ftol':1e-13,'maxiter':2000})
    assert minvol.success,(ix,'minvol',minvol.message)
    maximum_return=linprog(-means,A_ub=np.array([a for a,b in ub]),b_ub=np.array([b for a,b in ub]),A_eq=np.array([a for a,b in eq]),b_eq=np.array([b for a,b in eq]),bounds=bounds,method='highs')
    assert maximum_return.success
    maxmu=-maximum_return.fun
    for si, (source, outcomes) in enumerate(zip(f['sources'], actual)):
        source=np.array(source); source_mu=means@source; source_var=source@cov@source
        for mode,outcome in outcomes.items():
            target=outcome['target']; fit=None
            if mode=='same-risk':
                if minvol.fun*scale <= source_var+1e-7:
                    risk={'type':'ineq','fun':lambda w: (source_var-w@cov@w)/scale,'jac':lambda w:-2*cov@w/scale}
                    fit=minimize(lambda w:-means@w,minvol.x,jac=lambda w:-means,method='SLSQP',bounds=bounds,constraints=constraints+[risk],options={'ftol':1e-12,'maxiter':2000})
                    if not fit.success:
                        fit=minimize(lambda w:-means@w,fit.x,jac=lambda w:-means,method='SLSQP',bounds=bounds,constraints=constraints+[risk],options={'ftol':1e-10,'maxiter':2000})
                    if not fit.success:
                        oracle_trust_fallbacks += 1
                        linear=LinearConstraint(np.array([a for a,b in eq+ub]),np.array([b for a,b in eq]+[-np.inf]*len(ub)),np.array([b for a,b in eq+ub]))
                        quad=NonlinearConstraint(lambda w:w@cov@w/scale,-np.inf,source_var/scale,jac=lambda w:2*cov@w/scale,hess=lambda w,v:v[0]*2*cov/scale)
                        fit=minimize(lambda w:-means@w,minvol.x,jac=lambda w:-means,hess=lambda w:np.zeros_like(cov),method='trust-constr',bounds=Bounds(np.array(bounds)[:,0],np.array(bounds)[:,1]),constraints=[linear,quad],options={'gtol':1e-11,'xtol':1e-12,'barrier_tol':1e-12,'maxiter':3000})
                    assert fit.success,(ix,si,mode,fit.message)
                    refined=minimize(lambda w:-means@w,fit.x,jac=lambda w:-means,method='SLSQP',bounds=bounds,constraints=constraints+[risk],options={'ftol':1e-11,'maxiter':2000})
                    if refined.success: fit=refined
                    if means@fit.x < source_mu-2e-6: fit=None
            else:
                if source_mu<=maxmu+1e-8:
                    floor={'type':'ineq','fun':lambda w:means@w-source_mu,'jac':lambda w:means}
                    fit=minimize(objective,anchor,jac=gradient,method='SLSQP',bounds=bounds,constraints=constraints+[floor],options={'ftol':1e-13,'maxiter':2000})
                    assert fit.success,(ix,si,mode,fit.message)
                    if fit.fun*scale>source_var+2e-6: fit=None
            if fit is None:
                assert target is None,(ix,si,mode,'unexpected target',outcome)
                unavailable+=1
                continue
            assert target is not None,(ix,si,mode,'unexpected no target',outcome)
            weights=np.array(target['weights']); delta=np.array(outcome['deltas'])
            assert abs(sum(weights)-1)<1e-8
            assert all(lo-1e-7<=w<=hi+1e-7 for w,(lo,hi) in zip(weights,bounds))
            assert all(abs(a@weights-b)<1e-7 for a,b in eq)
            assert all(a@weights<=b+1e-7 for a,b in ub)
            assert means@weights>=source_mu-2e-6
            assert weights@cov@weights<=source_var+2e-6
            maximum['weight_change_identity']=max(maximum['weight_change_identity'],float(max(abs(delta-(weights-source)))))
            maximum['mu_identity']=max(maximum['mu_identity'],float(abs(target['mu']-means@weights)))
            maximum['variance_identity']=max(maximum['variance_identity'],float(abs(target['vol']**2-weights@cov@weights)))
            if mode=='same-risk':
                error=abs(means@weights-means@fit.x); maximum['same-risk_return_pct_points']=max(maximum['same-risk_return_pct_points'],float(error))
                assert error<2e-6,(ix,si,mode,error)
            else:
                error=abs(weights@cov@weights-fit.fun*scale); maximum['same-return_variance_pct_points_squared']=max(maximum['same-return_variance_pct_points_squared'],float(error))
                assert error<2e-6,(ix,si,mode,error)
            checked+=1
print(json.dumps({'fixtures':len(fixtures),'mode_source_cases':len(fixtures)*6,'optimal_targets_compared':checked,'unavailable_correctly_rejected':unavailable,'oracle_trust_constr_fallbacks':oracle_trust_fallbacks,'max_abs_error':maximum},indent=2))
