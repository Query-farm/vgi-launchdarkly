#!/usr/bin/env python3
"""Generate test/fixtures/launchdarkly-account.json, the replay account for the SQL tests.

The shapes follow LaunchDarkly's documented REST API v2 responses (OpenAPI spec at
https://app.launchdarkly.com/api/v2/openapi.json). All data is fictional. Regenerate with:

    python3 test/fixtures/build_fixture.py test/fixtures/launchdarkly-account.json
"""
import json, datetime as dt, sys
def ms(s): return int(dt.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()*1000)
M = {
 "m1": {"_id":"m1ada0000000000000000001","email":"ada@example.com","firstName":"Ada","lastName":"Lovelace","role":"admin","customRoles":[],"teams":[{"key":"platform","name":"Platform","customRoleKeys":[]}],"mfa":"enabled","_pendingInvite":False,"_verified":True,"_lastSeen":ms("2026-11-14T08:00:00Z"),"creationDate":ms("2024-01-10T00:00:00Z")},
 "m2": {"_id":"m2grace000000000000000002","email":"grace@example.com","firstName":"Grace","lastName":"Hopper","role":"writer","customRoles":["release-manager"],"teams":[{"key":"checkout-team","name":"Checkout","customRoleKeys":["release-manager"]}],"mfa":"enabled","_pendingInvite":False,"_verified":True,"_lastSeen":ms("2026-11-14T10:30:00Z"),"creationDate":ms("2024-02-01T00:00:00Z")},
 "m3": {"_id":"m3alan0000000000000000003","email":"alan@example.com","firstName":"Alan","lastName":"Turing","role":"reader","customRoles":[],"teams":[],"mfa":"disabled","_pendingInvite":True,"_verified":False,"_lastSeen":0,"creationDate":ms("2026-10-01T00:00:00Z")},
 "m4": {"_id":"m4kat00000000000000000004","email":"kat@example.com","firstName":"Katherine","lastName":"Johnson","role":"owner","customRoles":[],"teams":[{"key":"platform","name":"Platform","customRoleKeys":[]}],"mfa":"disabled","_pendingInvite":False,"_verified":True,"_lastSeen":ms("2026-11-01T00:00:00Z"),"creationDate":ms("2023-06-01T00:00:00Z")},
 "m5": {"_id":"m5radia000000000000000005","email":"radia@example.com","firstName":"Radia","lastName":"Perlman","role":"no_access","customRoles":["read-only-prod"],"teams":[{"key":"checkout-team","name":"Checkout","customRoleKeys":["release-manager"]}],"mfa":"enabled","_pendingInvite":False,"_verified":True,"_lastSeen":ms("2026-11-13T00:00:00Z"),"creationDate":ms("2025-03-01T00:00:00Z")},
}
for m in M.values(): m["_links"]={"self":{"href":f"/api/v2/members/{m['_id']}","type":"application/json"}}
def summ(m): return {"_links":m["_links"],"_id":m["_id"],"firstName":m["firstName"],"lastName":m["lastName"],"role":m["role"],"email":m["email"]}
def env(key,name,color,critical=False,approvals=False,tags=None,eid=None):
    return {"_links":{"self":{"href":"x"}},"_id":eid,"key":key,"name":name,"apiKey":"sdk-SECRET-"+eid,"mobileKey":"mob-SECRET-"+eid,"color":color,"defaultTtl":0,"secureMode":critical,"defaultTrackEvents":False,"requireComments":critical,"confirmChanges":critical,"tags":tags or [],"critical":critical,
      "approvalSettings":{"required":approvals,"bypassApprovalsForPendingChanges":False,"minNumApprovals":2 if approvals else 1,"canReviewOwnRequest":False,"canApplyDeclinedChanges":False,"serviceKind":"launchdarkly","serviceConfig":{},"requiredApprovalTags":[]}}
projects = [
 {"_id":"p1default000000000000001","key":"default","name":"Default","tags":["web"],"includeInSnippetByDefault":True,"defaultClientSideAvailability":{"usingMobileKey":False,"usingEnvironmentId":True},"defaultReleasePipelineKey":"standard","createdOn":ms("2023-06-01T00:00:00Z"),
  "environments":[env("production","Production","417505",True,True,["prod"],"6500000000000000000000a1"),env("staging","Staging","c0a000",False,False,["pre-prod"],"6500000000000000000000a2"),env("test","Test","7e8c9a",False,False,[],"6500000000000000000000a3")]},
 {"_id":"p2mobile0000000000000002","key":"mobile","name":"Mobile App","tags":["ios","android"],"includeInSnippetByDefault":False,"defaultClientSideAvailability":{"usingMobileKey":True,"usingEnvironmentId":False},"createdOn":ms("2024-05-01T00:00:00Z"),
  "environments":[env("production","Production","417505",True,False,["prod"],"6500000000000000000000b1"),env("development","Development","3d6ebc",False,False,[],"6500000000000000000000b2")]},
]
def boolvars(): return [{"_id":"v-true","value":True,"name":"On"},{"_id":"v-false","value":False,"name":"Off"}]
def cfg(env_name, on, last, ver, fall=None, off=1, rules=None, targets=None, ctargets=None, prereqs=None, proj="default", key="x", env_key="production"):
    return {"on":on,"archived":False,"salt":"s","sel":"x","lastModified":ms(last),"version":ver,"targets":targets or [],"contextTargets":ctargets or [],"rules":rules or [],
            "fallthrough":fall if fall is not None else {"variation":0},"offVariation":off,"prerequisites":prereqs or [],"_site":{"href":f"/{proj}/{env_key}/features/{key}","type":"text/html"},
            "_environmentName":env_name,"trackEvents":False,"trackEventsFallthrough":False,
            "_summary":{"variations":{"0":{"rules":len(rules or []),"nullRules":0,"targets":0,"contextTargets":0,"isFallthrough":True},"1":{"rules":0,"nullRules":0,"targets":0,"contextTargets":0,"isOff":True}},"prerequisites":len(prereqs or [])}}
def clause(cid, attr, op, values, kind="user", negate=False): return {"_id":cid,"attribute":attr,"op":op,"values":values,"contextKind":kind,"negate":negate}
def flag(key,name,kind,variations,temporary,tags,maint,created,envs,proj="default",description="",archived=False,deprecated=False,team=None,client=(False,False),custom=None,ver=1):
    f={"name":name,"kind":kind,"description":description,"key":key,"_version":ver,"creationDate":ms(created),"includeInSnippet":client[0],"clientSideAvailability":{"usingEnvironmentId":client[0],"usingMobileKey":client[1]},
       "variations":variations,"temporary":temporary,"tags":tags,"_links":{"self":{"href":f"/api/v2/flags/{proj}/{key}","type":"application/json"}},
       "maintainerId":M[maint]["_id"],"_maintainer":summ(M[maint]),"experiments":{"baselineIdx":0,"items":[]},"customProperties":custom or {},"archived":archived,"deprecated":deprecated,
       "defaults":{"onVariation":0,"offVariation":len(variations)-1},"environments":envs}
    if team: f["maintainerTeamKey"]=team; f["_maintainerTeam"]={"key":team,"name":team}
    if archived: f["archivedDate"]=ms("2026-09-01T00:00:00Z")
    if deprecated: f["deprecatedDate"]=ms("2026-08-01T00:00:00Z")
    return f
def envs_for(proj, key, spec):
    names={"production":"Production","staging":"Staging","test":"Test","development":"Development"}
    return {e: cfg(names[e], proj=proj, key=key, env_key=e, **kw) for e,kw in spec.items()}
flags_default = [
 flag("dark-mode","Dark mode","boolean",boolvars(),False,["ui","beta"],"m1","2025-01-15T00:00:00Z",
   envs_for("default","dark-mode",{
    "production":dict(on=True,last="2026-11-14T10:15:00Z",ver=12,
        targets=[{"values":["user-1","user-2"],"variation":0,"contextKind":"user"}],
        ctargets=[{"values":["org-9"],"variation":0,"contextKind":"organization"}],
        rules=[{"_id":"r-dm-1","variation":0,"clauses":[clause("c-dm-1","segmentMatch","segmentMatch",["beta-testers"]),clause("c-dm-2","country","in",["US","CA"])],"trackEvents":False,"description":"Beta testers in North America"},
               {"_id":"r-dm-2","rollout":{"variations":[{"variation":0,"weight":25000},{"variation":1,"weight":75000}],"bucketBy":"key","contextKind":"user"},"clauses":[clause("c-dm-3","email","endsWith",["@example.com"])],"trackEvents":True,"description":"Employees 25%"}]),
    "staging":dict(on=True,last="2026-11-10T00:00:00Z",ver=5,rules=[{"_id":"r-dm-s1","variation":0,"clauses":[clause("c-dm-s1","segmentMatch","segmentMatch",["beta-testers"])],"trackEvents":False,"description":"Beta"}]),
    "test":dict(on=False,last="2026-10-01T00:00:00Z",ver=2)}),
   client=(True,False),custom={"jira":{"name":"Jira","value":["WEB-12"]}},ver=19),
 flag("new-checkout","New checkout flow","boolean",boolvars(),True,["checkout"],"m2","2026-09-20T00:00:00Z",
   envs_for("default","new-checkout",{
    "production":dict(on=True,last="2026-11-14T10:42:00Z",ver=8,fall={"rollout":{"variations":[{"variation":0,"weight":10000},{"variation":1,"weight":90000}],"bucketBy":"key","contextKind":"user"}},
        prereqs=[{"key":"dark-mode","variation":0}],
        rules=[{"_id":"r-nc-1","variation":0,"disabled":True,"clauses":[clause("c-nc-1","segmentMatch","segmentMatch",["beta-testers","enterprise"])],"trackEvents":False,"description":"Beta and enterprise"}]),
    "staging":dict(on=True,last="2026-11-12T00:00:00Z",ver=4),
    "test":dict(on=True,last="2026-11-01T00:00:00Z",ver=3)}),
   team="checkout-team",client=(True,False)),
 flag("pricing-tier","Pricing tier","multivariate",[{"_id":"v-basic","value":"basic","name":"Basic"},{"_id":"v-pro","value":"pro","name":"Pro"},{"_id":"v-ent","value":"enterprise","name":"Enterprise"}],False,["pricing"],"m1","2024-03-01T00:00:00Z",
   envs_for("default","pricing-tier",{
    "production":dict(on=False,last="2026-06-01T00:00:00Z",ver=3,off=0,rules=[{"_id":"r-pt-1","variation":2,"clauses":[clause("c-pt-1","plan","in",["enterprise"],kind="organization"),clause("c-pt-2","seats","greaterThan",[100],kind="organization",negate=False)],"trackEvents":False,"description":"Big orgs"}]),
    "staging":dict(on=True,last="2026-06-01T00:00:00Z",ver=3,off=0),
    "test":dict(on=True,last="2026-06-01T00:00:00Z",ver=3,off=0)})),
 flag("legacy-banner","Legacy banner","boolean",boolvars(),True,["ui"],"m1","2023-07-01T00:00:00Z",
   envs_for("default","legacy-banner",{"production":dict(on=False,last="2026-08-30T00:00:00Z",ver=9),"staging":dict(on=False,last="2026-08-30T00:00:00Z",ver=9),"test":dict(on=False,last="2026-08-30T00:00:00Z",ver=9)}),archived=True),
 flag("old-search","Old search","boolean",boolvars(),True,["search"],"m2","2023-09-01T00:00:00Z",
   envs_for("default","old-search",{"production":dict(on=True,last="2026-07-01T00:00:00Z",ver=4),"staging":dict(on=True,last="2026-07-01T00:00:00Z",ver=4),"test":dict(on=True,last="2026-07-01T00:00:00Z",ver=4)}),deprecated=True),
 flag("api-rate-limit","API rate limit","multivariate",[{"_id":"v-100","value":100,"name":"Low"},{"_id":"v-1000","value":1000,"name":"High"},{"_id":"v-cfg","value":{"burst":50,"rate":500},"name":"Custom"}],False,["backend"],"m4","2025-05-05T00:00:00Z",
   envs_for("default","api-rate-limit",{"production":dict(on=True,last="2026-11-14T11:05:00Z",ver=6,fall={"variation":1},off=0),"staging":dict(on=True,last="2026-10-05T00:00:00Z",ver=2,off=0),"test":dict(on=True,last="2026-10-05T00:00:00Z",ver=2,off=0)}),team="platform"),
]
flags_mobile = [
 flag("onboarding-v2","Onboarding v2","boolean",boolvars(),True,["onboarding"],"m2","2026-10-10T00:00:00Z",
   envs_for("mobile","onboarding-v2",{"production":dict(on=False,last="2026-10-20T00:00:00Z",ver=2),"development":dict(on=True,last="2026-10-21T00:00:00Z",ver=3)}),client=(False,True)),
]
for fl in flags_default+flags_mobile:
    for k,c in fl["environments"].items(): c["_environmentName"]={"production":"Production","staging":"Staging","test":"Test","development":"Development"}[k]
# flag statuses: [name, lastRequested or None, default]
statuses = {
 "default/production": {"dark-mode":["active","2026-11-14T11:59:00Z",False],"new-checkout":["active","2026-11-14T11:58:00Z",False],"pricing-tier":["inactive","2026-09-01T00:00:00Z","basic"],"legacy-banner":["inactive","2026-08-30T00:00:00Z",False],"old-search":["launched","2026-11-14T11:00:00Z",True],"api-rate-limit":["launched","2026-11-14T11:30:00Z",1000]},
 "default/staging": {"dark-mode":["active","2026-11-13T00:00:00Z",False],"new-checkout":["new",None,None],"pricing-tier":["inactive","2026-06-02T00:00:00Z","basic"],"legacy-banner":["inactive","2026-08-30T00:00:00Z",False],"old-search":["launched","2026-11-12T00:00:00Z",True],"api-rate-limit":["launched","2026-11-12T00:00:00Z",1000]},
 "default/test": {"dark-mode":["inactive","2026-10-01T00:00:00Z",False],"new-checkout":["new",None,None],"pricing-tier":["new",None,None],"legacy-banner":["inactive","2026-08-30T00:00:00Z",False],"old-search":["launched","2026-11-01T00:00:00Z",True],"api-rate-limit":["active","2026-11-10T00:00:00Z",1000]},
 "mobile/production": {"onboarding-v2":["new",None,None]},
 "mobile/development": {"onboarding-v2":["active","2026-11-14T00:00:00Z",True]},
}
def seg(key,name,tags,created,modified,included=(),excluded=(),rules=(),unbounded=False,desc=None,ictx=()):
    s={"name":name,"tags":list(tags),"creationDate":ms(created),"lastModifiedDate":ms(modified),"key":key,"included":list(included),"excluded":list(excluded),"includedContexts":list(ictx),"excludedContexts":[],
       "_links":{"self":{"href":"x"}},"rules":list(rules),"version":3,"deleted":False,"generation":1,"unbounded":unbounded}
    if desc: s["description"]=desc
    if unbounded: s["unboundedContextKind"]="user"
    return s
segments = {
 "default/production":[
   seg("beta-testers","Beta testers",["beta"],"2025-01-01T00:00:00Z","2026-11-14T09:50:00Z",["user-1","user-2","user-3"],["user-9"],
       [{"_id":"sr-1","clauses":[clause("sc-1","email","endsWith",["@beta.example.com"])],"description":"Beta domain"}],desc="People in the beta program",ictx=[{"contextKind":"organization","values":["org-1"]}]),
   seg("enterprise","Enterprise customers",["enterprise"],"2025-02-01T00:00:00Z","2026-10-01T00:00:00Z",[],[],
       [{"_id":"sr-2","clauses":[clause("sc-2","plan","in",["enterprise"],kind="organization")],"description":"Enterprise plan"},{"_id":"sr-3","clauses":[clause("sc-3","seats","greaterThan",[500],kind="organization"),clause("sc-4","country","in",["US"],kind="organization")],"weight":50000,"bucketBy":"key"}]),
   seg("big-cohort","Big cohort",["beta","data"],"2026-03-01T00:00:00Z","2026-11-01T00:00:00Z",unbounded=True)],
 "default/staging":[seg("beta-testers","Beta testers",["beta"],"2025-01-01T00:00:00Z","2026-11-01T00:00:00Z",["user-1"],[],[])],
 "default/test":[],
 "mobile/production":[seg("ios-users","iOS users",["ios"],"2024-06-01T00:00:00Z","2026-01-01T00:00:00Z",[],[],[{"_id":"sr-4","clauses":[clause("sc-5","os","in",["iOS"],kind="device")]}])],
 "mobile/development":[],
}
context_kinds = {
 "default":[{"key":"user","name":"user","description":"","version":1,"creationDate":ms("2023-06-01T00:00:00Z"),"lastModified":ms("2023-06-01T00:00:00Z"),"lastSeen":ms("2026-11-14T11:59:00Z"),"createdFrom":"default","archived":False,"hideInTargeting":False,"_links":{}},
            {"key":"organization","name":"Organization","description":"Customer accounts","version":2,"creationDate":ms("2024-01-01T00:00:00Z"),"lastModified":ms("2024-02-01T00:00:00Z"),"lastSeen":ms("2026-11-14T11:00:00Z"),"createdFrom":"manual","archived":False,"_links":{}},
            {"key":"device","name":"device","description":"","version":1,"creationDate":ms("2024-03-01T00:00:00Z"),"lastModified":ms("2024-03-01T00:00:00Z"),"createdFrom":"auto-add","archived":True,"_links":{}}],
 "mobile":[{"key":"user","name":"user","description":"","version":1,"creationDate":ms("2024-05-01T00:00:00Z"),"lastModified":ms("2024-05-01T00:00:00Z"),"lastSeen":ms("2026-11-14T00:00:00Z"),"createdFrom":"default","archived":False,"_links":{}}],
}
teams = [
 {"key":"checkout-team","name":"Checkout","description":"Owns the checkout funnel","_creationDate":ms("2025-01-01T00:00:00Z"),"_lastModified":ms("2026-10-01T00:00:00Z"),"_version":3,"_idpSynced":False,"_links":{},"memberIds":[M["m2"]["_id"],M["m5"]["_id"]],"roleKeys":["release-manager"]},
 {"key":"platform","name":"Platform","description":"Infrastructure and APIs","_creationDate":ms("2024-01-01T00:00:00Z"),"_lastModified":ms("2026-05-01T00:00:00Z"),"_version":7,"_idpSynced":True,"_links":{},"memberIds":[M["m1"]["_id"],M["m4"]["_id"]],"roleKeys":[]},
 {"key":"empty-team","name":"Empty","description":"","_creationDate":ms("2026-01-01T00:00:00Z"),"_lastModified":ms("2026-01-01T00:00:00Z"),"_version":1,"_idpSynced":False,"_links":{},"memberIds":[],"roleKeys":[]},
]
roles = [
 {"_id":"role1","_links":{},"key":"release-manager","name":"Release manager","description":"Toggle production flags","basePermissions":"reader","resourceCategory":"project","assignedTo":{"membersCount":1,"teamsCount":1},
  "policy":[{"effect":"allow","actions":["updateOn","updateFallthrough"],"resources":["proj/*:env/production:flag/*"]},{"effect":"deny","actions":["deleteFlag"],"resources":["proj/*:env/*:flag/*"]}]},
 {"_id":"role2","_links":{},"key":"read-only-prod","name":"Read only production","basePermissions":"no_access","resourceCategory":"project","assignedTo":{"membersCount":1,"teamsCount":0},
  "policy":[{"effect":"allow","notActions":["*"],"resources":["proj/*:env/production:flag/*"]}]},
]
approvals = [
 {"_id":"ap1","_version":1,"creationDate":ms("2026-11-13T15:00:00Z"),"serviceKind":"launchdarkly","requestorId":M["m2"]["_id"],"description":"Ramp new checkout to 50%","reviewStatus":"pending","allReviews":[],"notifyMemberIds":[M["m1"]["_id"]],"notifyTeamKeys":["platform"],"status":"pending","instructions":[{"kind":"updateFallthroughVariationOrRollout","rolloutWeights":{"v-true":50000,"v-false":50000}}],"conflicts":[],"resourceId":"proj/default:env/production:flag/new-checkout","_links":{}},
 {"_id":"ap2","_version":2,"creationDate":ms("2026-11-10T09:00:00Z"),"serviceKind":"launchdarkly","requestorId":M["m1"]["_id"],"description":"Turn on dark mode","reviewStatus":"approved","allReviews":[{"_id":"rv1","kind":"approve","memberId":M["m4"]["_id"],"comment":"LGTM","creationDate":ms("2026-11-10T10:00:00Z")}],"notifyMemberIds":[M["m4"]["_id"]],"status":"completed","appliedDate":ms("2026-11-10T11:00:00Z"),"appliedByMemberId":M["m1"]["_id"],"instructions":[{"kind":"turnFlagOn"}],"conflicts":[],"resourceId":"proj/default:env/production:flag/dark-mode","_links":{}},
 {"_id":"ap3","_version":1,"creationDate":ms("2026-11-12T12:00:00Z"),"serviceKind":"launchdarkly","requestorId":M["m2"]["_id"],"description":"Add enterprise rule","reviewStatus":"declined","allReviews":[{"_id":"rv2","kind":"decline","memberId":M["m1"]["_id"],"comment":"Not yet"}],"notifyMemberIds":[M["m1"]["_id"]],"status":"pending","instructions":[{"kind":"addRule"}],"conflicts":[],"resourceId":"proj/default:env/production:segment/enterprise","_links":{}},
 {"_id":"ap4","_version":1,"creationDate":ms("2026-11-14T08:00:00Z"),"serviceKind":"launchdarkly","requestorId":M["m2"]["_id"],"description":"Schedule onboarding","reviewStatus":"pending","allReviews":[],"notifyMemberIds":[M["m1"]["_id"]],"status":"scheduled","executionDate":ms("2026-12-01T09:00:00Z"),"instructions":[{"kind":"turnFlagOn"}],"conflicts":[],"resourceId":"proj/mobile:env/production:flag/onboarding-v2","_links":{}},
]
scheduled = {
 "default/production/new-checkout":[{"_id":"sc1","_creationDate":ms("2026-11-13T00:00:00Z"),"_maintainerId":M["m2"]["_id"],"_version":1,"executionDate":ms("2026-11-20T09:00:00Z"),"instructions":[{"kind":"updateFallthroughVariationOrRollout","variationId":"v-true"}],"conflicts":None,"_links":{}}],
 "default/staging/dark-mode":[{"_id":"sc2","_creationDate":ms("2026-11-01T00:00:00Z"),"_maintainerId":M["m1"]["_id"],"_version":2,"executionDate":ms("2026-11-18T00:00:00Z"),"instructions":[{"kind":"turnFlagOff"},{"kind":"removeRule","ruleId":"r-dm-s1"}],"conflicts":[{"_id":"sc9","reason":"overlaps"}],"_links":{}}],
}
experiments = {
 "default":[
  {"_id":"ex1","key":"checkout-conversion","name":"Checkout conversion","description":"Does the new checkout convert better?","_maintainerId":M["m2"]["_id"],"_creationDate":ms("2026-10-01T00:00:00Z"),"environmentKey":"production","methodology":"bayesian","dataSource":"launchdarkly","tags":["checkout"],"type":"experiment","_links":{},
   "currentIteration":{"_id":"it1","hypothesis":"New checkout lifts conversion by 5%","status":"running","createdAt":ms("2026-10-02T00:00:00Z"),"startedAt":ms("2026-10-03T00:00:00Z"),"randomizationUnit":"user","flags":{"new-checkout":{"targetingRule":"fallthrough","flagConfigVersion":8,"_links":{}}},
    "primarySingleMetric":{"key":"checkout-completed","name":"Checkout completed","kind":"custom","_links":{}},"metrics":[{"key":"checkout-completed","_versionId":"mv1","name":"Checkout completed","kind":"custom","isGroup":False,"_links":{}},{"key":"page-load-ms","_versionId":"mv2","name":"Page load","kind":"custom","isGroup":False,"_links":{}}],
    "treatments":[{"_id":"v-false","name":"Control","allocationPercent":"50","baseline":True},{"_id":"v-true","name":"New checkout","allocationPercent":"50","baseline":False}]}},
  {"_id":"ex2","key":"pricing-test","name":"Pricing page test","_maintainerId":M["m1"]["_id"],"_creationDate":ms("2026-05-01T00:00:00Z"),"environmentKey":"production","methodology":"frequentist","dataSource":"launchdarkly","tags":["pricing"],"_links":{},
   "currentIteration":{"_id":"it2","hypothesis":"Pro sells better","status":"stopped","createdAt":ms("2026-05-02T00:00:00Z"),"startedAt":ms("2026-05-03T00:00:00Z"),"endedAt":ms("2026-06-01T00:00:00Z"),"winningTreatmentId":"v-pro","winningReason":"Significant lift","flags":{"pricing-tier":{"_links":{}}},
    "primarySingleMetric":{"key":"pricing-page-view","name":"Pricing page view","kind":"pageview","_links":{}},"metrics":[{"key":"pricing-page-view","_versionId":"mv3","name":"Pricing page view","kind":"pageview","isGroup":False,"_links":{}}],
    "treatments":[{"_id":"v-basic","name":"Basic","allocationPercent":"50","baseline":True},{"_id":"v-pro","name":"Pro","allocationPercent":"50","baseline":False}]}},
  {"_id":"ex3","key":"old-banner-test","name":"Old banner test","_maintainerId":M["m1"]["_id"],"_creationDate":ms("2024-01-01T00:00:00Z"),"archivedDate":ms("2024-06-01T00:00:00Z"),"environmentKey":"staging","methodology":"bayesian","tags":[],"_links":{},
   "currentIteration":{"_id":"it3","hypothesis":"Banner helps","status":"stopped","createdAt":ms("2024-01-02T00:00:00Z"),"flags":{"legacy-banner":{"_links":{}}},"metrics":[],"treatments":[]}}],
 "mobile":[],
}
metrics = {"default":[
  {"_id":"mt1","_versionId":"mv1","_version":1,"key":"checkout-completed","name":"Checkout completed","kind":"custom","eventKey":"checkout-completed","isNumeric":False,"successCriteria":"HigherThanBaseline","tags":["checkout","conversion"],"_creationDate":ms("2026-09-01T00:00:00Z"),"maintainerId":M["m2"]["_id"],"dataSource":{"key":"launchdarkly-hosted"},"_attachedFlagCount":1,"experimentCount":1,"lastSeen":ms("2026-11-14T11:00:00Z"),"archived":False,"analysisUnits":["user"],"unitAggregationType":"sum","analysisType":"mean","_links":{}},
  {"_id":"mt2","_versionId":"mv2","_version":3,"key":"page-load-ms","name":"Page load","kind":"custom","eventKey":"page-load","isNumeric":True,"unit":"ms","successCriteria":"LowerThanBaseline","tags":["performance"],"_creationDate":ms("2025-09-01T00:00:00Z"),"maintainerId":M["m4"]["_id"],"dataSource":{"key":"launchdarkly-hosted"},"_attachedFlagCount":2,"experimentCount":1,"archived":False,"analysisUnits":["user"],"unitAggregationType":"average","analysisType":"percentile","percentileValue":95,"_links":{}},
  {"_id":"mt3","_versionId":"mv3","_version":1,"key":"pricing-page-view","name":"Pricing page view","kind":"pageview","tags":["pricing","conversion"],"_creationDate":ms("2026-04-01T00:00:00Z"),"maintainerId":M["m1"]["_id"],"dataSource":{"key":"launchdarkly-hosted"},"_attachedFlagCount":0,"experimentCount":1,"archived":False,"urls":[{"kind":"substring","substring":"/pricing"}],"_links":{}}],
 "mobile":[]}
pipelines = {"default":[
  {"createdAt":"2025-06-01T00:00:00Z","description":"Test, then staging, then production","key":"standard","name":"Standard release","tags":["default"],"_version":2,"isProjectDefault":True,"_isLegacy":False,
   "phases":[{"id":"ph1","name":"Testing","audiences":[{"name":"Test","environment":{"key":"test","name":"Test","color":"x","_links":{}}},{"name":"Staging","environment":{"key":"staging","name":"Staging","color":"x","_links":{}}}]},
             {"id":"ph2","name":"Production","audiences":[{"name":"Production","environment":{"key":"production","name":"Production","color":"x","_links":{}},"segmentKeys":["beta-testers"]}]}]},
  {"createdAt":"2026-01-01T00:00:00Z","key":"hotfix","name":"Hotfix","tags":[],"_version":1,"isProjectDefault":False,"_isLegacy":True,"phases":[{"id":"ph3","name":"Production","audiences":[{"name":"Production","environment":{"key":"production","name":"Production","color":"x","_links":{}}}]}]}],
 "mobile":[]}
repos = [
 {"name":"web-app","sourceLink":"https://github.com/example/web-app","type":"github","defaultBranch":"main","enabled":True,"version":4,"_links":{},
  "branches":[{"name":"main","head":"a1b2c3d","syncTime":ms("2026-11-14T06:00:00Z"),"_links":{},
     "references":[{"path":"src/theme.ts","hint":"typescript","hunks":[{"startingLineNumber":12,"lines":"if (ld.variation('dark-mode', false)) {","projKey":"default","flagKey":"dark-mode","aliases":["darkMode"]},{"startingLineNumber":40,"lines":"const dm = flags.darkMode;","projKey":"default","flagKey":"dark-mode","aliases":["darkMode"]}]},
                   {"path":"src/checkout/index.ts","hint":"typescript","hunks":[{"startingLineNumber":5,"lines":"ld.variation('new-checkout', false)","projKey":"default","flagKey":"new-checkout","aliases":[]}]}]},
     {"name":"feature/x","head":"ffff111","syncTime":ms("2026-11-10T06:00:00Z"),"_links":{},"references":[{"path":"src/x.ts","hint":"typescript","hunks":[{"startingLineNumber":1,"lines":"ld.variation('dark-mode')","projKey":"default","flagKey":"dark-mode","aliases":[]}]}]}]},
 {"name":"api-server","sourceLink":"https://gitlab.com/example/api-server","type":"gitlab","defaultBranch":"master","enabled":True,"version":2,"_links":{},
  "branches":[{"name":"master","head":"9988776","syncTime":ms("2026-11-13T06:00:00Z"),"_links":{},
     "references":[{"path":"limits/rate.go","hint":"go","hunks":[{"startingLineNumber":88,"lines":"client.IntVariation(\"api-rate-limit\", ctx, 100)","projKey":"default","flagKey":"api-rate-limit","aliases":[]}]},
                   {"path":"mobile/onboard.go","hint":"go","hunks":[{"startingLineNumber":3,"lines":"BoolVariation(\"onboarding-v2\")","projKey":"mobile","flagKey":"onboarding-v2","aliases":[]}]}]}]},
]
def audit(i, date, kind, name, specifier, member, title_verb, desc, actions, comment=None, token=None, related=None, parent=None, offset=None):
    e={"_links":{"self":{"href":f"/api/v2/auditlog/al{i:02d}"}},"_id":f"al{i:02d}","_accountId":"acct1","accesses":[{"action":a,"resource":specifier} for a in actions],
       "kind":kind,"name":name,"description":desc,"shortDescription":desc.split("\n")[0],"titleVerb":title_verb,"target":{"_links":{},"name":name,"resources":[specifier]}}
    if offset is not None: e["date_offset_minutes"]=offset
    else: e["date"]=ms(date)
    who=""
    if member: e["member"]={"_links":{},"_id":M[member]["_id"],"email":M[member]["email"],"firstName":M[member]["firstName"],"lastName":M[member]["lastName"]}; who=M[member]["firstName"]+" "+M[member]["lastName"]
    if token: e["token"]={"_links":{},"_id":token[0],"name":token[1],"ending":"ab12","serviceToken":token[2]}; who=token[1]
    e["subject"]={"_links":{},"name":who}
    e["title"]=f"{who} {title_verb} {name}"
    if comment: e["comment"]=comment
    if related: e["relatedFlag"]={"key":related}
    if parent: e["parent"]={"_links":{},"name":parent[0],"resource":parent[1]}
    e["__detail"]={"delta":[{"op":"replace","path":"/environments/production/on","value":True}] if kind=="flag" else None,"previousVersion":{"on":False} if kind=="flag" else None,"currentVersion":{"on":True} if kind=="flag" else None}
    return e
P="proj/default:env/production"
auditlog = [
 audit(1,"2026-11-14T11:05:00Z","flag","API rate limit",f"{P}:flag/api-rate-limit","m4","changed the default variation of","- Changed the default rule to serve **High**",["updateFallthrough"],parent=("Production",P)),
 audit(2,"2026-11-14T10:42:00Z","flag","New checkout flow",f"{P}:flag/new-checkout","m2","updated the targeting rules of","- Changed rollout to 10% / 90%\n- Disabled rule 1",["updateRules","updateFallthrough"],comment="Ramping up",parent=("Production",P)),
 audit(3,"2026-11-14T10:15:00Z","flag","Dark mode",f"{P}:flag/dark-mode","m1","turned on","- Turned targeting **on**",["updateOn"],parent=("Production",P)),
 audit(4,"2026-11-14T09:50:00Z","segment","Beta testers",f"{P}:segment/beta-testers","m2","updated","- Added user-3 to included targets",["updateIncluded"],related="dark-mode"),
 audit(5,"2026-11-14T09:30:00Z","flag","Dark mode","proj/default:env/staging:flag/dark-mode",None,"updated the targeting rules of","- Added rule",["updateRules"],token=("tok1","ci-deployer",True)),
 audit(6,"2026-11-14T08:15:00Z","flag","New checkout flow",f"{P}:flag/new-checkout","m2","turned on","- Turned targeting **on**",["updateOn"]),
 audit(7,"2026-11-13T16:00:00Z","environment","Production",P,"m1","updated","- Required comments",["updateRequireComments"]),
 audit(8,"2026-11-13T12:00:00Z","member","grace@example.com","member/m2grace000000000000000002","m4","updated the role of","- Role changed to **writer**",["updateMemberRole"]),
 audit(9,"2026-11-12T10:00:00Z","role","Release manager","role/release-manager","m4","updated","- Added updateFallthrough",["updatePolicy"]),
 audit(10,"2026-11-11T10:00:00Z","flag","Onboarding v2","proj/mobile:env/development:flag/onboarding-v2","m2","turned on","- Turned targeting **on**",["updateOn"]),
 audit(11,"2026-11-10T11:00:00Z","flag","Dark mode",f"{P}:flag/dark-mode","m1","applied an approved change to","- Applied approval ap2",["applyApprovalRequest"]),
 audit(12,"2026-11-09T09:00:00Z","project","Mobile App","proj/mobile","m4","updated","- Added tag android",["updateTags"]),
 audit(13,"2020-01-01T00:00:00Z","flag","Legacy banner",f"{P}:flag/legacy-banner","m1","created","- Created flag",["createFlag"]),
 audit(14,None,"flag","Dark mode",f"{P}:flag/dark-mode","m1","updated the description of","- Description edited",["updateDescription"],offset=90),
 audit(15,None,"segment","Enterprise customers",f"{P}:segment/enterprise","m2","updated","- Added rule",["updateRules"],offset=180),
]
out = {"members":list(M.values()),"projects":projects,"flags":{"default":flags_default,"mobile":flags_mobile},"flag_statuses":statuses,"segments":segments,"context_kinds":context_kinds,
       "teams":teams,"roles":roles,"approval_requests":approvals,"scheduled_changes":scheduled,"experiments":experiments,"metrics":metrics,"release_pipelines":pipelines,"repositories":repos,"auditlog":auditlog}
json.dump(out, open(sys.argv[1],"w"), indent=1, sort_keys=False)
