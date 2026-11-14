import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@shared/permissions';
import type { ErpOpType } from '@shared/erp';
import type { Db, Tx } from '../../db';
import type { Actor, Deps } from '../../lib/context';
import { guard } from '../../auth/guard';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { assertNotFenced, lockOpKey } from '../../lib/fences';
import { hashRequest } from '../../lib/idempotency';
import { setTxTimeouts } from '../../lib/tx';
import { writeAudit } from '../../lib/audit';
import { parse } from '../../lib/validate';
import { dateIn } from '../../lib/dates';
import { erpOpAbandoned } from '../erp-ops';
import { canonicalMemberId } from '../concierge/native-links';

const id = z.number().int().positive().safe();
const prose = (max: number) => z.string().trim().min(1).max(max).refine(s => !s.includes('\0'),'文字含无效字符');
const optionalText = (max: number) => z.string().trim().max(max).refine(s => !s.includes('\0'),'文字含无效字符').default('');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s,'日期不存在');
const base = z.object({ requestKey: z.uuid() });
const noteInput = base.extend({memberId:id.nullable().optional(),visitId:id.nullable().optional(),staffId:id.optional(),kind:z.enum(['reception','maintenance']),occurredAt:z.iso.datetime({offset:true}),outcome:prose(500),content:prose(4000),feedback:optionalText(2000),nextContactOn:day.nullable().optional()}).strict();
const bindInput = base.extend({memberId:id,toStaffId:id,expectedVersion:z.number().int().min(0),reason:prose(1000)}).strict();
const bindReviewInput = base.extend({expectedVersion:z.number().int().positive(),decision:z.enum(['approve','reject']),reason:prose(1000)}).strict();
const claimInput = base.extend({rechargeId:id,sellerId:id.nullable(),firstKind:z.enum(['unknown','first','renewal']),ownerDepartment:z.enum(['unknown','customer','frontdesk']),expectedVersion:z.number().int().min(0),reason:prose(1000)}).strict();
const creditReviewInput = base.extend({expectedVersion:z.number().int().positive(),decision:z.enum(['verify','reject','void']),reason:prose(1000)}).strict();
const targetInput = base.extend({month:z.string().regex(/^(19\d\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/),staffId:id.nullable(),groupName:optionalText(80),amountCents:z.number().int().nonnegative().safe(),expectedVersion:z.number().int().min(0),reason:prose(1000)}).strict();
const param = z.object({id:z.coerce.number().int().positive().safe()});

async function member(db: Db, memberId: number) { const [m]=await db`SELECT id FROM members WHERE id=${memberId}`;if(!m)throw notFound('会员不存在'); }
/**
 * 所选的人此刻能不能承接：在岗、不是系统账号，是客户经理；店主、店总只有本人自己选了自己才算（selectorId 是选他的人）。
 * 审核绑定申请时 selectorId 是当初的申请人，不是审核的人——不然店总给自己申请的绑定，店主审核时会被当成「选了别的管理者」而通不过，
 * 只能由申请人自己审自己的（Codex 2026-11-14 在 a41dfa7 上的审查）。
 */
async function eligibleTarget(tx: Tx, selected: number, selectorId: number) {
  const [s]=await tx`SELECT id,active,system,role FROM staff WHERE id=${selected} FOR SHARE`;
  if(!s||!s.active||s.system||!(s.role==='account_manager'||(selected===selectorId&&['owner','store_manager'].includes(s.role))))throw badRequest('请选择在岗客户经理；管理者仅可明确选择自己');
}
/** 经办人这一次能不能选这个人：所选的人能承接，并且没有管理权限的只能选自己。 */
async function eligible(tx: Tx, selected: number, actor: Actor) {
  await eligibleTarget(tx,selected,actor.id);
  if(!can(actor,'customer.manage')&&selected!==actor.id)throw forbidden('只能记录本人的服务或成交，不能代替另一位经理');
}
export async function customerMaintainerAt(db: Db, memberId: number | null, occurredAt: string): Promise<number|null> {
  if(memberId===null)return null;
  const [row]=await db`SELECT to_staff_id FROM customer_binding_events WHERE member_id=${memberId} AND effective_at<=${occurredAt}::timestamptz ORDER BY effective_at DESC,id DESC LIMIT 1`;
  return row?Number(row.toStaffId):null;
}
async function audit(tx: Tx,actor: Actor,type: string,ref: number,before: unknown,after: unknown,reason: string,ip?:string){
  await writeAudit(tx,{staffId:actor.id,action:'customer_record',targetType:'customer_'+type,targetId:ref,detail:{before,after,reason},ip});
}
async function operation<T extends {requestKey:string}>(deps: Deps,actor: Actor,type: ErpOpType,input: T,work:(tx:Tx)=>Promise<number>){
  const hash=hashRequest({type,input});
  return deps.sql.begin(async tx=>{
    await setTxTimeouts(tx);await lockOpKey(tx,input.requestKey);
    const [old]=await tx`SELECT op_type,request_hash,ref_id,staff_id FROM idempotency_keys WHERE key=${input.requestKey}::uuid`;
    if(old){if(old.opType!==type||old.requestHash!==hash||Number(old.staffId)!==actor.id)throw conflict('IDEMPOTENCY_CONFLICT','操作编号已用于另一笔或另一位员工的请求');return{id:Number(old.refId)};}
    await assertNotFenced(tx,input.requestKey,type,erpOpAbandoned);
    const ref=await work(tx);
    await tx`INSERT INTO idempotency_keys(key,op_type,request_hash,ref_id,staff_id) VALUES(${input.requestKey}::uuid,${type},${hash},${ref},${actor.id})`;
    return{id:ref};
  });
}
async function bindingRow(tx:Tx,memberId:number){
  await member(tx,memberId);await tx`INSERT INTO customer_bindings(member_id) VALUES(${memberId}) ON CONFLICT DO NOTHING`;
  const [row]=await tx`SELECT * FROM customer_bindings WHERE member_id=${memberId} FOR UPDATE`;return row!;
}
async function requireUnmerged(tx:Tx,memberId:number){
  const [row]=await tx`SELECT merged_into_id FROM members WHERE id=${memberId} FOR SHARE`;
  if(!row)throw notFound('会员不存在');
  if(row.mergedIntoId!==null)throw conflict('CUSTOMER_MEMBER_MERGED','会员已合并，请打开当前主账号重新申请');
}
/** Hold the native source and current destination while writing the claim; do not change native facts. */
async function lockedCanonical(tx:Tx,memberId:number){
  const canonical=await canonicalMemberId(tx,memberId);
  if(canonical===null)throw notFound('充值会员不存在');
  const ids=[...new Set([memberId,canonical])].sort((a,b)=>a-b);
  await tx`SELECT id FROM members WHERE id IN ${tx(ids)} ORDER BY id FOR SHARE`;
  if(await canonicalMemberId(tx,memberId)!==canonical)throw conflict('CUSTOMER_MEMBER_MERGED','会员正在合并，请刷新当前主账号后重试');
  return canonical;
}
export function registerCustomerWriteRoutes(app:FastifyInstance,deps:Deps){
  app.post('/api/customer/notes',{preHandler:guard('customer.read','customer.operate')},async req=>{
    const p=parse(noteInput,req.body),actor=req.actor;
    return operation(deps,actor,'customer_note',p,async tx=>{
      const selected=p.staffId??actor.id;await eligible(tx,selected,actor);
      let memberId=p.memberId??null;
      if(!memberId&&!p.visitId)throw badRequest('会员或原生来访至少选择一项');
      if(p.visitId){const [v]=await tx`SELECT member_id FROM visits WHERE id=${p.visitId}`;if(!v)throw notFound('来访不存在');if(memberId!==null&&(v.memberId===null||await canonicalMemberId(tx,Number(v.memberId))!==await canonicalMemberId(tx,memberId)))throw badRequest('来访不属于所选会员');memberId=v.memberId===null?null:Number(v.memberId);}
      if(memberId!==null)await member(tx,memberId);
      if(Date.parse(p.occurredAt)>Date.now()+300000)throw badRequest('服务发生时间不能在未来');
      if(p.nextContactOn&&p.nextContactOn<dateIn(p.occurredAt,deps.config.timezone))throw badRequest('下次跟进日期不能早于本次服务');
      const owner=await customerMaintainerAt(tx,memberId,p.occurredAt);
      const [row]=await tx`INSERT INTO customer_service_notes(member_id,visit_id,staff_id,kind,occurred_at,outcome,content,feedback,next_contact_on,maintainer_at_event,created_by) VALUES(${memberId},${p.visitId??null},${selected},${p.kind},${p.occurredAt}::timestamptz,${p.outcome},${p.content},${p.feedback},${p.nextContactOn??null}::date,${owner},${actor.id}) RETURNING *`;
      await audit(tx,actor,'note',Number(row!.id),null,row,'',req.ip);return Number(row!.id);
    });
  });
  app.post('/api/customer/bindings/requests',{preHandler:guard('customer.read','customer.operate')},async req=>{
    const p=parse(bindInput,req.body),actor=req.actor;
    return operation(deps,actor,'customer_binding_request',p,async tx=>{
      const current=await bindingRow(tx,p.memberId);
      await requireUnmerged(tx,p.memberId);
      if(current.version!==p.expectedVersion)throw conflict('CUSTOMER_VERSION','维护关系已变化，请刷新核对');
      await eligible(tx,p.toStaffId,actor);
      if(Number(current.maintainerStaffId)===p.toStaffId)throw badRequest('该经理已经是当前维护人');
      const [pending]=await tx`SELECT id FROM customer_binding_requests WHERE member_id=${p.memberId} AND status='pending'`;
      if(pending)throw conflict('CUSTOMER_PENDING','该会员已有待审核申请');
      const [row]=await tx`INSERT INTO customer_binding_requests(member_id,from_staff_id,to_staff_id,expected_version,reason,requested_by) VALUES(${p.memberId},${current.maintainerStaffId},${p.toStaffId},${current.version},${p.reason},${actor.id}) RETURNING *`;
      await audit(tx,actor,'binding_request',Number(row!.id),null,row,p.reason,req.ip);return Number(row!.id);
    });
  });
  app.post('/api/customer/bindings/requests/:id/review',{preHandler:guard('customer.read','customer.manage')},async req=>{
    const p=parse(bindReviewInput,req.body),ref=parse(param,req.params).id,actor=req.actor;
    return operation(deps,actor,'customer_binding_review',{...p,id:ref},async tx=>{
      const [initial]=await tx`SELECT member_id FROM customer_binding_requests WHERE id=${ref}`;if(!initial)throw notFound('绑定申请不存在');
      const current=await bindingRow(tx,Number(initial.memberId));
      const [row]=await tx`SELECT * FROM customer_binding_requests WHERE id=${ref} FOR UPDATE`;
      if(row!.version!==p.expectedVersion||row!.status!=='pending')throw conflict('CUSTOMER_VERSION','申请已处理，请刷新');
      if(p.decision==='approve'){
        await requireUnmerged(tx,Number(row!.memberId));
        if(current.version!==row!.expectedVersion||current.maintainerStaffId!==row!.fromStaffId)throw conflict('CUSTOMER_VERSION','原维护关系已变化，不能套用旧申请');
        // 审核时再核对一次承接人还在岗、岗位还对；「管理者只能选自己」按申请人算（申请时已经核对过申请人的权限）
        await eligibleTarget(tx,Number(row!.toStaffId),Number(row!.requestedBy));
        // Native recharges use the application clock; a different PG clock can reorder historical ownership.
        const [event]=await tx`INSERT INTO customer_binding_events(member_id,from_staff_id,to_staff_id,request_id,version,approved_by,effective_at) VALUES(${row!.memberId},${row!.fromStaffId},${row!.toStaffId},${ref},${current.version+1},${actor.id},${new Date().toISOString()}::timestamptz) RETURNING effective_at`;
        await tx`UPDATE customer_bindings SET maintainer_staff_id=${row!.toStaffId},version=version+1,updated_at=${event!.effectiveAt}::timestamptz WHERE member_id=${row!.memberId}`;
      }
      const [after]=await tx`UPDATE customer_binding_requests SET status=${p.decision==='approve'?'approved':'rejected'},version=version+1,reviewed_by=${actor.id},reviewed_at=clock_timestamp(),review_reason=${p.reason} WHERE id=${ref} RETURNING *`;
      await audit(tx,actor,'binding_review',ref,row,after,p.reason,req.ip);return ref;
    });
  });
  app.post('/api/customer/credits/claim',{preHandler:guard('customer.read','customer.operate')},async req=>{
    const p=parse(claimInput,req.body),actor=req.actor;
    return operation(deps,actor,'customer_credit_claim',p,async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'customer_credit:'+p.rechargeId},0))`;
      const [recharge]=await tx`SELECT id,member_id,created_at FROM recharges WHERE id=${p.rechargeId}`;if(!recharge)throw notFound('原生充值不存在');
      if(p.sellerId!==null)await eligible(tx,p.sellerId,actor);else if(!can(actor,'customer.manage'))throw forbidden('普通客户经理只能认领本人，未知成交人交管理者核对');
      const [before]=await tx`SELECT * FROM customer_recharge_credits WHERE recharge_id=${p.rechargeId} FOR UPDATE`;
      const canonical=await lockedCanonical(tx,Number(recharge.memberId));
      if((before?.version??0)!==p.expectedVersion||before&&!['rejected','voided'].includes(before.status))throw conflict('CUSTOMER_VERSION','该充值已有认领或版本已变化，请打开原记录核对');
      let row;
      if(before){[row]=await tx`UPDATE customer_recharge_credits SET canonical_member_id=${canonical},seller_staff_id=${p.sellerId},first_kind=${p.firstKind},owner_department=${p.ownerDepartment},status='pending',version=version+1,reason=${p.reason},claimed_by=${actor.id},claimed_at=clock_timestamp(),reviewed_by=NULL,reviewed_at=NULL,review_reason='' WHERE id=${before.id} RETURNING *`;}
      else{const owner=await customerMaintainerAt(tx,Number(recharge.memberId),recharge.createdAt);[row]=await tx`INSERT INTO customer_recharge_credits(recharge_id,member_id,canonical_member_id,occurred_at,seller_staff_id,first_kind,owner_department,reason,maintainer_at_event,claimed_by) VALUES(${p.rechargeId},${recharge.memberId},${canonical},${recharge.createdAt}::timestamptz,${p.sellerId},${p.firstKind},${p.ownerDepartment},${p.reason},${owner},${actor.id}) RETURNING *`;}
      await tx`INSERT INTO customer_credit_events(credit_id,version,action,snapshot,actor_id,reason) VALUES(${row!.id},${row!.version},'claim',${tx.json(row!)},${actor.id},${p.reason})`;
      await audit(tx,actor,'credit_claim',Number(row!.id),before??null,row,p.reason,req.ip);return Number(row!.id);
    });
  });
  app.post('/api/customer/credits/:id/review',{preHandler:guard('customer.read','customer.manage')},async req=>{
    const p=parse(creditReviewInput,req.body),ref=parse(param,req.params).id,actor=req.actor;
    return operation(deps,actor,'customer_credit_review',{...p,id:ref},async tx=>{
      const [row]=await tx`SELECT * FROM customer_recharge_credits WHERE id=${ref} FOR UPDATE`;if(!row)throw notFound('归属记录不存在');
      if(row.version!==p.expectedVersion||(p.decision==='void'?row.status!=='verified':row.status!=='pending'))throw conflict('CUSTOMER_VERSION','归属状态或版本已变化');
      if(p.decision==='verify'&&await lockedCanonical(tx,Number(row.memberId))!==Number(row.canonicalMemberId))throw conflict('CUSTOMER_MEMBER_MERGED','认领后会员发生合并，请驳回后按当前主账号重新认领');
      if(p.decision==='verify'&&(row.firstKind==='unknown'||row.ownerDepartment==='unknown'||row.ownerDepartment==='customer'&&row.sellerStaffId===null))throw badRequest('首续、部门及客户部成交人未核实完整，不能计入已核业绩');
      const [after]=await tx`UPDATE customer_recharge_credits SET status=${{verify:'verified',reject:'rejected',void:'voided'}[p.decision]},version=version+1,reviewed_by=${actor.id},reviewed_at=clock_timestamp(),review_reason=${p.reason} WHERE id=${ref} RETURNING *`;
      await tx`INSERT INTO customer_credit_events(credit_id,version,action,snapshot,actor_id,reason) VALUES(${ref},${after!.version},${p.decision},${tx.json(after!)},${actor.id},${p.reason})`;
      await audit(tx,actor,'credit_review',ref,row,after,p.reason,req.ip);return ref;
    });
  });
  app.post('/api/customer/targets',{preHandler:guard('customer.read','customer.manage')},async req=>{
    const p=parse(targetInput,req.body),actor=req.actor;
    return operation(deps,actor,'customer_target',p,async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'customer_target:'+p.month+':'+(p.staffId??'department')},0))`;
      if(p.staffId!==null)await eligible(tx,p.staffId,actor);
      const [before]=await tx`SELECT * FROM customer_month_targets WHERE month=${p.month+'-01'}::date AND staff_id IS NOT DISTINCT FROM ${p.staffId}::bigint FOR UPDATE`;
      if((before?.version??0)!==p.expectedVersion)throw conflict('CUSTOMER_VERSION','目标版本已变化，请刷新核对');
      const [row]=before?await tx`UPDATE customer_month_targets SET target_cents=${p.amountCents},group_name=${p.groupName},version=version+1,updated_by=${actor.id},updated_at=clock_timestamp() WHERE id=${before.id} RETURNING *`:await tx`INSERT INTO customer_month_targets(month,staff_id,group_name,target_cents,updated_by) VALUES(${p.month+'-01'}::date,${p.staffId},${p.groupName},${p.amountCents},${actor.id}) RETURNING *`;
      await tx`INSERT INTO customer_target_versions(target_id,version,snapshot,actor_id,reason) VALUES(${row!.id},${row!.version},${tx.json(row!)},${actor.id},${p.reason})`;
      await audit(tx,actor,'target',Number(row!.id),before??null,row,p.reason,req.ip);return Number(row!.id);
    });
  });
}
