export type Availability = 'available' | 'limited' | 'partial' | 'unavailable';
export type Scope = {type:'fleet'|'supplier'|'owner'|'hostname'|'domain'|'network';value:string;fleetId?:string};
export type Dimension = 'infrastructure'|'service'|'fleet'|'hostname'|'domain'|'owner'|'supplier'|'gateway'|'application'|'week'|'hour'|'selected_count'|'session_value';
export type Filter = {dimension:Dimension;value:string};
export type Query = {scope:Scope;period:'7'|'14'|'30';filters:Filter[]} & ({serviceIds:string[];serviceId?:string}|{serviceId:string;serviceIds?:never});
export type Interval = [number,number] | null;
export interface Rewards {
  availability:Availability;reason:string|null;
  actualPokt:number|null;equalSharePokt:number|null;ratio:number|null;differencePercent:number|null;
  intervalRatio:Interval;intervalDifferencePercent:Interval;
  direction:'above'|'below'|'no_clear_difference'|'not_assessed';
  informativeDays:number;positiveSessions:number;comparableSessions:number;recordedSessions:number;
  coverage:number;largestDayShare:number|null;
  daily:{date:string;actual:number;reference:number;sessions:number;positiveSessions:number}[];
  bootstrap:{definedDraws:number;repetitions:number};
}
export interface ScenarioReference {
  observedAt:string;totalEligible:number;ownEligible:number;selectionCap:number;populationId:string;assumption:string;
}
export interface ProductReport {
  schemaVersion:1;dataKind:'illustrative'|'live';snapshotId:string;generatedAt:string;query:Query;
  scope:Omit<Scope,'fleetId'> & {label:string;fleetId:string|null;fleetNames:string[];supplierCount:number;identityCount:number;latestEligibleCount:number|null;membershipRule:string;fictional:boolean;filters:Filter[];sampleNotice:string|null};
  service:{id:string;name:string;shortName:string};
  services:{id:string;name:string;shortName:string}[];
  period:{start:string;endExclusive:string;timezone:'UTC';requestedDays:number};
  rewards:Rewards;
  exposure:{availability:'available'|'unavailable';reason:string|null;recordedSessions:number;verifiedSessions:number;presentSessions:number;presenceFraction:number|null;meanSelected:number|null;expectedPresenceFraction:number|null;expectedMeanSelected:number|null;eligibleRange:Interval;missingRosters:number;selectedPositions:number};
  scenarioReference:ScenarioReference|null;
  scenarioReferences:(ScenarioReference & {serviceId:string;serviceName:string})[];
  perService:(Rewards & {id:string;label:string;exposure:ProductReport['exposure']})[];
  trend:{points:(Rewards & {id:string;label:string})[];variable:boolean;earlierRatio:number|null;laterRatio:number|null};
  evidence:{recordedSessions:number;verifiedRosters:number;comparableOutcomes:number;missingOutcomes:number;pendingOutcomes:number;zeroPoolSessions:number;informativeDays:number;positiveOpportunities:number;largestDayShare:number|null;membershipRule:string;sourceNotice:string;sampling:string;thresholdNotice:string;limitations:string[]};
}
export interface Breakdown {
  dimension:Dimension;rows:(Rewards & {id:string;label:string;description:string|null;query:Query;exposure:ProductReport['exposure']})[];totalGroups:number;overlapping:boolean;note:string|null;
}
export interface SessionFrame {
  sessionId:string;serviceId:string;date:string;startedAt:string;gatewayId:string|null;applicationId:string;populationId:string;
  N:number;n:number;K:number;X:number|null;selectionReady:boolean;comparisonReady:boolean;
  payoutStatus:'complete'|'missing'|'pending';rosterStatus:'complete'|'missing';
  pool:number|null;actual:number|null;reference:number|null;availableAt:string|null;
}
export type EarningsEstimate = {availability:'unavailable';reason:string} | {
  availability:'available';earlierRatio:number;laterRatio:number;
  equalDailyErrorPokt:number;earlierDailyErrorPokt:number;improvementFraction:number|null;testDays:number;
  trainingPeriod:{start:string;endExclusive:string};gapPeriod:{start:string;endExclusive:string};testPeriod:{start:string;endExclusive:string};
  trainingDays:number;trainingSessions:number;testCoverage:number;method:string;
  daily:{date:string;actualPokt:number;equalSharePokt:number;earlierEstimatePokt:number;comparableSessions:number}[];
};
