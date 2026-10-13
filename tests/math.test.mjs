import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionDistribution,selectionTail,exposureScenario,countForTarget,dayBootstrap} from '../src/math.js';

const close=(a,b,tolerance=1e-10)=>assert(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);
const choose=(n,k)=>{let value=1;for(let i=1;i<=k;i++)value=value*(n-i+1)/i;return value;};

test('hypergeometric probabilities match direct combinatorial enumeration',()=>{
  for(const [N,n,K] of [[10,3,4],[13,1,13],[8,5,3],[30,7,10],[0,0,0]]) {
    const p=selectionDistribution(N,n,K);
    close(p.reduce((a,b)=>a+b,0),1);
    for(let x=0;x<=K;x++) {
      const expected=x<=n&&K-x<=N-n?choose(n,x)*choose(N-n,K-x)/choose(N,K):0;
      close(p[x],expected);
    }
    close(p.reduce((sum,value,x)=>sum+x*value,0),N?K*n/N:0);
  }
});

test('scenario expands the network total and handles saturation and zero counts',()=>{
  const ref={totalEligible:1300,ownEligible:60,selectionCap:50};
  const a=exposureScenario(ref,120);
  assert.equal(a.totalEligible,1360);assert.equal(a.otherEligible,1240);
  close(a.expectedPositions,50*120/1360);
  assert.equal(exposureScenario(ref,0).selectionChance,0);
  const small={totalEligible:13,ownEligible:1,selectionCap:50};
  assert.equal(exposureScenario(small,1).selectionChance,1);
  assert.equal(exposureScenario(small,10,5).selectionChance,1);
  assert.equal(exposureScenario(small,10,5).expectedPositions,10);
  assert.equal(exposureScenario({totalEligible:0,ownEligible:0,selectionCap:50},0).expectedPositions,0);
});

test('multiple-position tail, monotonicity and target counts are exact',()=>{
  for(const minimum of [1,2,3,5]) {
    let previous=0;
    for(let own=0;own<=100;own++) {
      const tail=selectionTail(400,own,50,minimum);
      assert(tail>=previous-1e-10);previous=tail;
      close(tail,selectionDistribution(400+own,own,50).slice(minimum).reduce((a,b)=>a+b,0),1e-8);
    }
    const ref={totalEligible:448,ownEligible:48,selectionCap:50};
    for(const target of [.9,.95,.99]) {
      const own=countForTarget(ref,target,minimum);
      assert(selectionTail(400,own,50,minimum)>=target);
      assert(selectionTail(400,own-1,50,minimum)<target);
    }
  }
  assert.equal(countForTarget({totalEligible:100,ownEligible:5,selectionCap:2},.95,3),null);
  assert.throws(()=>selectionDistribution(10,11,5),RangeError);
});

test('whole-day bootstrap preserves payout/opportunity pairs and deterministic uncertainty',()=>{
  const daily=[{actual:20,reference:10},{actual:10,reference:30},{actual:12,reference:20}];
  const result=dayBootstrap(daily,7);
  close(result.point,42/60);assert.equal(result.definedDraws,2000);
  assert.deepEqual(result,dayBootstrap(daily,7));
  assert(result.interval[0]>=1/3&&result.interval[1]<=2);
  assert.equal(dayBootstrap([{actual:20,reference:10}],7).interval,null);
  assert.equal(dayBootstrap([{actual:0,reference:0},{actual:0,reference:0}],7).point,null);
  assert.deepEqual(dayBootstrap([{actual:20,reference:10},{actual:40,reference:20}],7).interval,[2,2]);
});


test('custom minimums and decimal targets retain smallest-count guarantees without false 100% certainty',()=>{
  const ref={totalEligible:448,ownEligible:48,selectionCap:50};
  for(const minimum of [7,17,50])for(const target of [.485,.989,.999]){
    const count=countForTarget(ref,target,minimum);
    if(count===null){assert(selectionTail(400,100000,50,minimum)<target);continue;}
    assert(selectionTail(400,count,50,minimum)>=target);
    assert(selectionTail(400,count-1,50,minimum)<target);
  }
  assert.equal(countForTarget(ref,1,7),null);
  assert(selectionTail(400,100000,50,1)<1);
  assert(selectionTail(400,100000,50,7)<1);
  assert.equal(countForTarget({totalEligible:13,ownEligible:1,selectionCap:50},1,7),7);
  for(const target of [0,-.1,1.01,NaN])assert.throws(()=>countForTarget(ref,target,7),RangeError);
  assert.throws(()=>countForTarget(ref,.95,7.5),RangeError);
});
