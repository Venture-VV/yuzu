import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createMember, login, PASSWORD, rechargeBody, setup, type TestContext } from './helpers';
import { createStaff } from '../src/server/modules/staff';

let ctx:TestContext,a=0,b=0,ca='',cb='',memberId=0,secondId=0,recharge1=0,recharge2=0,creditId=0;
const post=(cookie:string,path:string,p:Record<string,unknown>,key=randomUUID())=>api(ctx.app,cookie,'POST','/api/customer'+path,{...p,requestKey:key});
const claim=(extra:Record<string,unknown>={})=>({rechargeId:recharge1,sellerId:a,firstKind:'unknown',ownerDepartment:'unknown',expectedVersion:0,reason:'隔离库原生充值待核',...extra});
async function bind(to:number,version:number){
 const request=await post(ctx.owner,'/bindings/requests',{memberId,toStaffId:to,expectedVersion:version,reason:'合成维护交接'});
 expect(request.status,JSON.stringify(request.body)).toBe(200);
 const reviewed=await post(ctx.owner,`/bindings/requests/${request.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'管理者核实通过'});
 expect(reviewed.status,JSON.stringify(reviewed.body)).toBe(200);return request.body.id as number;
}
async function nativeRecharge(){
 const r=await api(ctx.app,ctx.owner,'POST','/api/recharges',rechargeBody(memberId,10000));expect(r.status,JSON.stringify(r.body)).toBe(200);
 const [row]=await ctx.sql`SELECT id FROM recharges WHERE member_id=${memberId} ORDER BY id DESC LIMIT 1`;return Number(row!.id);
}
describe('客户部本地工作台写入：不写钱包、独立责任、版本与通用幂等',()=>{
 beforeAll(async()=>{
  ctx=await setup();
  a=await createStaff(ctx.sql,{username:'customer-a',displayName:'合成客户经理甲',role:'account_manager',password:PASSWORD,mustChangePassword:false});
  b=await createStaff(ctx.sql,{username:'customer-b',displayName:'合成客户经理乙',role:'account_manager',password:PASSWORD,mustChangePassword:false});
  ca=await login(ctx.app,'customer-a');cb=await login(ctx.app,'customer-b');
  memberId=(await createMember(ctx,'合成客户部会员甲','19900003101')).id;
  secondId=(await createMember(ctx,'合成客户部会员乙','19900003102')).id;
  recharge1=await nativeRecharge();
 });
 afterAll(async()=>{await ctx?.close();});
 it('无会话/普通收银无客户部写权限；目标初始为空且不套演示目标',async()=>{
  const payload={memberId,kind:'maintenance',occurredAt:new Date().toISOString(),outcome:'已联系',content:'合成事实'};
  expect((await post('', '/notes',payload)).status).toBe(401);
  expect((await post(ctx.clerk,'/notes',payload)).status).toBe(403);
  const [row]=await ctx.sql`SELECT count(*)::int AS count FROM customer_month_targets`;expect(row!.count).toBe(0);
 });
 it('服务只记录实际人员；禁止代录同事及伪造金额/维护人；同编号并发只写一次',async()=>{
  const payload={memberId,staffId:a,kind:'maintenance',occurredAt:new Date().toISOString(),outcome:'已联系',content:'客人反馈暂不充值',feedback:'保留客人原意'};
  expect((await post(ca,'/notes',{...payload,staffId:b})).status).toBe(403);
  expect((await post(ca,'/notes',{...payload,amountCents:1})).status).toBe(400);
  expect((await post(ca,'/notes',{...payload,maintainerAtEvent:b})).status).toBe(400);
  const key=randomUUID(),[x,y]=await Promise.all([post(ca,'/notes',payload,key),post(ca,'/notes',payload,key)]);
  expect(x.status,JSON.stringify(x.body)).toBe(200);expect(y.body).toEqual(x.body);
  const [note]=await ctx.sql`SELECT * FROM customer_service_notes WHERE id=${x.body.id}`;expect(note).toMatchObject({staffId:a,createdBy:a,maintainerAtEvent:null});
  expect((await post(ca,'/notes',{...payload,content:'改内容'},key)).status).toBe(409);
  expect((await post(cb,'/notes',payload,key)).status).toBe(409);
  expect((await api(ctx.app,ca,'GET',`/api/erp/ops/${key}?type=customer_note`)).body).toMatchObject({found:true,refId:x.body.id});
  expect((await api(ctx.app,cb,'GET',`/api/erp/ops/${key}?type=customer_note`)).status).toBe(403);
  expect((await api(ctx.app,cb,'POST',`/api/erp/ops/${key}/abandon`,{type:'customer_note'})).status).toBe(403);
 });
 it('通用确认作废拦下晚到请求，不能用其他业务类型冒名拦截',async()=>{
  const p={memberId,kind:'maintenance',occurredAt:new Date().toISOString(),outcome:'合成待写',content:'不应重复'};
  const key=randomUUID();expect((await api(ctx.app,ca,'POST',`/api/erp/ops/${key}/abandon`,{type:'customer_note'})).status).toBe(200);
  expect((await post(ca,'/notes',p,key)).status).toBe(409);
  expect((await api(ctx.app,ca,'POST',`/api/erp/ops/${randomUUID()}/abandon`,{type:'customer_credit_review'})).status).toBe(403);
 });
 it('绑定申请不生效，管理审核才改变维护关系且重复审批/旧版本拒绝',async()=>{
  const p={memberId,toStaffId:a,expectedVersion:0,reason:'合成申请'};
  const r=await post(ca,'/bindings/requests',p);expect(r.status,JSON.stringify(r.body)).toBe(200);
  let [binding]=await ctx.sql`SELECT * FROM customer_bindings WHERE member_id=${memberId}`;expect(binding).toMatchObject({maintainerStaffId:null,version:0});
  expect((await post(ca,`/bindings/requests/${r.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'越权'})).status).toBe(403);
  expect((await post(ctx.owner,`/bindings/requests/${r.body.id}/review`,{expectedVersion:2,decision:'approve',reason:'旧版本'})).status).toBe(409);
  const key=randomUUID(),review={expectedVersion:1,decision:'approve',reason:'审核事实后通过'};
  const done=await post(ctx.owner,`/bindings/requests/${r.body.id}/review`,review,key);expect(done.status,JSON.stringify(done.body)).toBe(200);
  expect((await post(ctx.owner,`/bindings/requests/${r.body.id}/review`,review,key)).body).toEqual(done.body);
  [binding]=await ctx.sql`SELECT * FROM customer_bindings WHERE member_id=${memberId}`;expect(binding).toMatchObject({maintainerStaffId:a,version:1});
  expect((await post(ctx.owner,`/bindings/requests/${r.body.id}/review`,review)).status).toBe(409);
  expect((await post(ctx.owner,'/bindings/requests',{memberId,toStaffId:b,expectedVersion:0,reason:'过时维护版本'})).status).toBe(409);
  recharge2=await nativeRecharge();
 });
 it('批准换绑后再认领旧充值，发生时维护人仍按交易时有效历史，不随现任覆盖',async()=>{
  await bind(b,1);
  const old=await post(ca,'/credits/claim',claim());expect(old.status,JSON.stringify(old.body)).toBe(200);creditId=old.body.id;
  const recent=await post(ca,'/credits/claim',claim({rechargeId:recharge2,firstKind:'renewal',ownerDepartment:'customer'}));expect(recent.status,JSON.stringify(recent.body)).toBe(200);
  const records=await ctx.sql`SELECT recharge_id,maintainer_at_event,seller_staff_id,claimed_by FROM customer_recharge_credits ORDER BY recharge_id`;
  expect(records).toEqual([{rechargeId:recharge1,maintainerAtEvent:null,sellerStaffId:a,claimedBy:a},{rechargeId:recharge2,maintainerAtEvent:a,sellerStaffId:a,claimedBy:a}]);
  const [current]=await ctx.sql`SELECT maintainer_staff_id FROM customer_bindings WHERE member_id=${memberId}`;expect(current!.maintainerStaffId).toBe(b);
  const [native]=await ctx.sql`SELECT operator_id FROM recharges WHERE id=${recharge2}`;expect(native!.operatorId).toBe(ctx.ownerId);
 });
 it('5K/首续/部门不自动套用；未知归属不能核定，普通员工不能核定或冒用别人',async()=>{
  expect((await post(ca,'/credits/claim',claim({rechargeId:recharge2,sellerId:b,expectedVersion:1}))).status).toBe(403);
  expect((await post(ca,`/credits/${creditId}/review`,{expectedVersion:1,decision:'verify',reason:'自己核定'})).status).toBe(403);
  expect((await post(ctx.owner,`/credits/${creditId}/review`,{expectedVersion:1,decision:'verify',reason:'首续未知'})).status).toBe(400);
  expect((await post(ca,'/credits/claim',claim({amountCents:500000}))).status).toBe(400);
 });
 it('驳回后可版本化重报，核定后需留因撤销，原始每版保留',async()=>{
  expect((await post(ctx.owner,`/credits/${creditId}/review`,{expectedVersion:1,decision:'reject',reason:'缺少首续依据'})).status).toBe(200);
  const resubmit=await post(ca,'/credits/claim',claim({expectedVersion:2,firstKind:'renewal',ownerDepartment:'customer',reason:'已查旧系统为续充'}));expect(resubmit.status,JSON.stringify(resubmit.body)).toBe(200);expect(resubmit.body.id).toBe(creditId);
  expect((await post(ctx.owner,`/credits/${creditId}/review`,{expectedVersion:3,decision:'verify',reason:'人工核实原单'})).status).toBe(200);
  expect((await post(ca,'/credits/claim',claim({expectedVersion:4}))).status).toBe(409);
  expect((await post(ctx.owner,`/credits/${creditId}/review`,{expectedVersion:4,decision:'void',reason:''})).status).toBe(400);
  expect((await post(ctx.owner,`/credits/${creditId}/review`,{expectedVersion:4,decision:'void',reason:'复核发现归属需重查'})).status).toBe(200);
  const versions=await ctx.sql`SELECT version,action FROM customer_credit_events WHERE credit_id=${creditId} ORDER BY version`;expect(versions.map(x=>x.version)).toEqual([1,2,3,4,5]);expect(versions.map(x=>x.action)).toEqual(['claim','reject','claim','verify','void']);
 });
 it('服务补录按发生时间记录维护人，未来及错配来访拒绝',async()=>{
  const p={memberId,kind:'maintenance',occurredAt:new Date(Date.now()-3600000).toISOString(),outcome:'补录历史联系',content:'真实反馈留档'};
  const r=await post(ca,'/notes',p);expect(r.status,JSON.stringify(r.body)).toBe(200);
  const [note]=await ctx.sql`SELECT maintainer_at_event FROM customer_service_notes WHERE id=${r.body.id}`;expect(note!.maintainerAtEvent).toBeNull();
  expect((await post(ca,'/notes',{...p,occurredAt:new Date(Date.now()+3600000).toISOString()})).status).toBe(400);
  expect((await post(ca,'/notes',{...p,memberId:null})).status).toBe(400);
  expect((await post(ca,'/notes',{...p,visitId:999999999})).status).toBe(404);
 });
 it('冻结员工只留历史，不能作为新维护/成交人；驳回不改变绑定',async()=>{
  const request=await post(ctx.owner,'/bindings/requests',{memberId:secondId,toStaffId:b,expectedVersion:0,reason:'准备换绑'});expect(request.status).toBe(200);
  await ctx.sql`UPDATE staff SET active=false WHERE id=${b}`;
  expect((await post(ctx.owner,`/bindings/requests/${request.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'目标已冻结'})).status).toBe(400);
  expect((await post(ctx.owner,`/bindings/requests/${request.body.id}/review`,{expectedVersion:1,decision:'reject',reason:'冻结员工不承接'})).status).toBe(200);
  const [row]=await ctx.sql`SELECT version,maintainer_staff_id FROM customer_bindings WHERE member_id=${secondId}`;expect(row).toMatchObject({version:0,maintainerStaffId:null});
 });
 it('店总给自己申请的绑定由店主审核通过；审核人不能借别人的申请把另一位管理者绑上去',async()=>{
  // Codex 2026-11-14（a41dfa7）：原来审核时拿审核人去套「管理者只能选自己」，店总给自己的申请只有店总自己审才通得过
  const sm=await createStaff(ctx.sql,{username:'customer-sm',displayName:'合成店总',role:'store_manager',password:PASSWORD,mustChangePassword:false});
  const csm=await login(ctx.app,'customer-sm');
  const third=(await createMember(ctx,'合成客户部会员戊','19900003151')).id;
  const own=await post(csm,'/bindings/requests',{memberId:third,toStaffId:sm,expectedVersion:0,reason:'店总自己维护这位'});
  expect(own.status,JSON.stringify(own.body)).toBe(200);
  const approved=await post(ctx.owner,`/bindings/requests/${own.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'店主核实通过'});
  expect(approved.status,JSON.stringify(approved.body)).toBe(200);
  const [bound]=await ctx.sql`SELECT version,maintainer_staff_id FROM customer_bindings WHERE member_id=${third}`;
  expect(bound).toMatchObject({version:1,maintainerStaffId:sm});
  // 申请时的限制没有放松：店主不能把会员申请给店总（管理者只能选自己）
  const other=await post(ctx.owner,'/bindings/requests',{memberId:secondId,toStaffId:sm,expectedVersion:0,reason:'替店总申请'});
  expect(other.status,JSON.stringify(other.body)).toBe(400);
  // 承接人离岗以后审核仍然通不过
  const fourth=(await createMember(ctx,'合成客户部会员己','19900003152')).id;
  const pending=await post(csm,'/bindings/requests',{memberId:fourth,toStaffId:sm,expectedVersion:0,reason:'再申请一位'});
  expect(pending.status,JSON.stringify(pending.body)).toBe(200);
  await ctx.sql`UPDATE staff SET active=false WHERE id=${sm}`;
  expect((await post(ctx.owner,`/bindings/requests/${pending.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'承接人已离岗'})).status).toBe(400);
  expect((await post(ctx.owner,`/bindings/requests/${pending.body.id}/review`,{expectedVersion:1,decision:'reject',reason:'承接人已离岗'})).status).toBe(200);
 });
 it('月目标仅manage版本化配置，部门与个人独立，无默认640万，不覆盖历史月份',async()=>{
  const p={month:'2026-11',staffId:null,amountCents:1234567,expectedVersion:0,reason:'本地试算目标'};
  expect((await post(ca,'/targets',p)).status).toBe(403);
  const made=await post(ctx.owner,'/targets',p);expect(made.status,JSON.stringify(made.body)).toBe(200);
  expect((await post(ctx.owner,'/targets',{...p,amountCents:0})).status).toBe(409);
  expect((await post(ctx.owner,'/targets',{...p,amountCents:2000000,expectedVersion:1})).status).toBe(200);
  expect((await post(ctx.owner,'/targets',{...p,month:'2026-10',amountCents:0})).status).toBe(200);
  expect((await post(ctx.owner,'/targets',{...p,staffId:a,groupName:'本地组A',amountCents:50000})).status).toBe(200);
  expect((await post(ctx.owner,'/targets',{...p,month:'2026-09',amountCents:1.5})).status).toBe(400);
  expect((await post(ctx.owner,'/targets',{...p,month:'1899-12'})).status).toBe(400);
  const rows=await ctx.sql`SELECT month,staff_id,target_cents FROM customer_month_targets ORDER BY month,staff_id NULLS FIRST`;expect(rows).toEqual([{month:'2026-10-01',staffId:null,targetCents:0},{month:'2026-11-01',staffId:null,targetCents:2000000},{month:'2026-11-01',staffId:a,targetCents:50000}]);
  const v=await ctx.sql`SELECT version FROM customer_target_versions WHERE target_id=${made.body.id} ORDER BY version`;expect(v.map(x=>x.version)).toEqual([1,2]);
 });
 it('原生合并后旧待审绑定与认领不能核定到别的主账号，驳回重报保留快照',async()=>{
  const source=(await createMember(ctx,'合成待合并会员','19900003103')).id;
  const target=(await createMember(ctx,'合成合并主账号','19900003104')).id;
  const charged=await api(ctx.app,ctx.owner,'POST','/api/recharges',rechargeBody(source,10000));expect(charged.status,JSON.stringify(charged.body)).toBe(200);
  const rechargeId=Number(charged.body.recharge.id);
  const request=await post(ca,'/bindings/requests',{memberId:source,toStaffId:a,expectedVersion:0,reason:'合并前申请'});expect(request.status).toBe(200);
  const credited=await post(ca,'/credits/claim',claim({rechargeId,firstKind:'renewal',ownerDepartment:'customer'}));expect(credited.status).toBe(200);
  const check=await api(ctx.app,ctx.owner,'GET',`/api/members/${source}/merge-check?targetId=${target}`);expect(check.status).toBe(200);
  const merged=await api(ctx.app,ctx.owner,'POST',`/api/members/${source}/merge`,{clientKey:randomUUID(),targetId:target,reason:'合成重复档案合并',expectedPrincipal:check.body.principal,expectedBonus:check.body.bonus});expect(merged.status,JSON.stringify(merged.body)).toBe(200);
  const [before]=await ctx.sql`SELECT principal_balance,bonus_balance FROM members WHERE id=${target}`;
  expect((await post(ctx.owner,`/bindings/requests/${request.body.id}/review`,{expectedVersion:1,decision:'approve',reason:'旧申请不得迁移生效'})).status).toBe(409);
  expect((await post(ca,'/bindings/requests',{memberId:source,toStaffId:a,expectedVersion:0,reason:'禁止在旧档重开'})).status).toBe(409);
  expect((await post(ctx.owner,`/credits/${credited.body.id}/review`,{expectedVersion:1,decision:'verify',reason:'旧认领不得静默迁移'})).status).toBe(409);
  expect((await post(ctx.owner,`/bindings/requests/${request.body.id}/review`,{expectedVersion:1,decision:'reject',reason:'账号已合并，重新申请'})).status).toBe(200);
  expect((await post(ctx.owner,`/credits/${credited.body.id}/review`,{expectedVersion:1,decision:'reject',reason:'按当前主账号重新认领'})).status).toBe(200);
  expect((await post(ca,'/credits/claim',claim({rechargeId,expectedVersion:2,firstKind:'renewal',ownerDepartment:'customer'}))).status).toBe(200);
  expect((await post(ctx.owner,`/credits/${credited.body.id}/review`,{expectedVersion:3,decision:'verify',reason:'已核对合并后的主账号'})).status).toBe(200);
  const events=await ctx.sql`SELECT snapshot->>'canonicalMemberId' AS canonical FROM customer_credit_events WHERE credit_id=${credited.body.id} ORDER BY version`;
  expect(events.map(x=>Number(x.canonical))).toEqual([source,source,target,target]);
  const [after]=await ctx.sql`SELECT principal_balance,bonus_balance FROM members WHERE id=${target}`;expect(after).toEqual(before);
 });
 it('只追加历史和数据库版本保护；所有服务/归属写入不改原生财务',async()=>{
  const [note]=await ctx.sql`SELECT id FROM customer_service_notes ORDER BY id LIMIT 1`;
  await expect(ctx.sql`DELETE FROM customer_service_notes WHERE id=${note!.id}`).rejects.toThrow();
  await expect(ctx.sql`DELETE FROM customer_credit_events WHERE credit_id=${creditId}`).rejects.toThrow();
  await expect(ctx.sql`UPDATE customer_recharge_credits SET recharge_id=${recharge2},version=version+1 WHERE id=${creditId}`).rejects.toThrow();
  await expect(ctx.sql`UPDATE customer_bindings SET maintainer_staff_id=${a} WHERE member_id=${memberId}`).rejects.toThrow();
  const [funds]=await ctx.sql`SELECT (SELECT principal_balance FROM members WHERE id=${memberId}) AS principal,(SELECT count(*)::int FROM recharges WHERE member_id=${memberId}) AS charges,(SELECT count(*)::int FROM consumptions WHERE member_id=${memberId}) AS consumes`;
  expect(funds).toMatchObject({principal:20000,charges:2,consumes:0});
 });
});
