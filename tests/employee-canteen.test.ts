import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setup, api, TEST_DB, type TestContext } from './helpers';
import { createSql, type Sql } from '../src/server/db';
import { buildEmployeeApp } from '../src/employee/server/app';
import { migrateEmployee } from '../src/employee/server/migrate';
import { loadEmployeeConfig } from '../src/employee/server/config';
import { syncCanteen } from '../src/server/modules/canteen/sync';
import type { CanteenMenuInput, CanteenEmployee } from '../src/shared/canteen';

const INITIAL = 'Initial-test-2026';
const CHANGED = 'Changed-test-2026';
const KEY = 'synthetic-employee-integration-9f3e7c5a2468';
const PORT = Number(process.env.CANTEEN_TEST_PORT ?? 18964);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
let ctx: TestContext;
let portal: FastifyInstance;
let psql: Sql;
let portalDb: string;
let departmentId: number;
let people: Record<string, CanteenEmployee & {version:number}> = {};
let cookies: Record<string, string> = {};
const call = async (who: string | null, method: 'GET'|'POST', path: string, payload?: unknown) => {
  const r = await portal.inject({method,url:`/api/employee${path}`,headers:{origin:ORIGIN,...(who?{cookie:cookies[who]}:{})},...(payload===undefined?{}:{payload:payload as object})});
  return {status:r.statusCode,body:r.json(),cookie:r.cookies[0] ? `${r.cookies[0].name}=${r.cookies[0].value}` : undefined};
};
const menu = (meal: 'breakfast'|'lunch'|'dinner', published: boolean): CanteenMenuInput => ({id:randomUUID(),date:today,meal,title:'今日合成菜单',dishes:['番茄炒蛋','清炒时蔬'],notes:'仅用于独立测试',published,version:0});

beforeAll(async()=>{
  ctx = await setup();
  const url = new URL(TEST_DB); portalDb = url.pathname.slice(1) + '_employee';
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(portalDb)) throw new Error('拒绝非测试库');
  await ctx.sql.unsafe(`CREATE DATABASE "${portalDb}"`);
  url.pathname = '/'+portalDb; psql=createSql(url.toString());
  await migrateEmployee(psql);
  portal = await buildEmployeeApp(psql, {...loadEmployeeConfig({EMPLOYEE_DATABASE_URL:url.toString(),EMPLOYEE_SYNC_KEY:KEY,EMPLOYEE_PORT:String(PORT),PUBLIC_ORIGIN:ORIGIN,YUZU_INSTANCE:'test'}),staticRoot:'/nonexistent'});
  await portal.listen({host:'127.0.0.1',port:PORT});
  ctx.config.employeePortal={url:ORIGIN,syncKey:KEY};
}, 60000);
afterAll(async()=>{
  if(portal) await portal.close();
  if(psql) await psql.end();
  if(ctx){ if(portalDb) await ctx.sql.unsafe(`DROP DATABASE IF EXISTS "${portalDb}" WITH (FORCE)`); await ctx.close(); }
});

describe('独立员工服务与内网食堂管理',()=>{
  it('默认关闭、后台权限隔离；不能把员工服务初始化在ERP库', async()=>{
    expect((await api(ctx.app,ctx.owner,'GET','/api/erp/canteen/overview')).status).toBe(403);
    await ctx.sql`INSERT INTO settings (key,value) VALUES ('erp_modules','{"canteen":true}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
    expect((await api(ctx.app,ctx.clerk,'GET','/api/erp/canteen/overview')).status).toBe(403);
    await expect(migrateEmployee(ctx.sql)).rejects.toThrow('其他业务表');
    expect((await portal.inject({url:'/api/staff'})).statusCode).toBe(404);
  });
  it('后台设置食堂部门，创建独立账号并幂等返回原结果，不新增ERP员工',async()=>{
    const [dep]=await ctx.sql<{id:number}[]>`INSERT INTO departments(name) VALUES ('合成员工食堂') RETURNING id`;departmentId=dep!.id;
    const set={departmentId,version:1};
    expect((await api(ctx.app,ctx.owner,'PUT','/api/erp/canteen/settings',set)).status).toBe(200);
    expect((await api(ctx.app,ctx.owner,'PUT','/api/erp/canteen/settings',set)).status).toBe(200);
    for(const role of ['employee','chef','manager'] as const){
      const input={requestId:randomUUID(),employeeNo:`TEST_${role.toUpperCase()}`,name:`合成${role}`,departmentId,role,password:INITIAL};
      const first=await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/employees',input);
      expect(first.status,JSON.stringify(first.body)).toBe(201);people[role]=first.body.employee;
      const again=await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/employees',input);
      expect(again.body).toEqual(first.body);
    }
    const [count]=await ctx.sql<{n:number}[]>`SELECT count(*) AS n FROM staff`;
    expect(count!.n).toBe(2);
    const overview=await api(ctx.app,ctx.owner,'GET','/api/erp/canteen/overview');
    expect(JSON.stringify(overview.body)).not.toContain('passwordHash');
    expect(overview.body.sync.pending).toBe(true);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
  });
  it('登录强制改初始密码；独立Cookie、CSRF和密码规则生效',async()=>{
    const foreign=await portal.inject({method:'POST',url:'/api/employee/login',headers:{origin:'https://evil.example'},payload:{employeeNo:people.employee!.employeeNo,password:INITIAL}});
    expect(foreign.statusCode).toBe(403);
    for(const who of ['employee','chef','manager']){
      const login=await call(null,'POST','/login',{employeeNo:people[who]!.employeeNo,password:INITIAL});
      expect(login.status).toBe(200);cookies[who]=login.cookie!;
      expect(login.body.employee.mustChangePassword).toBe(true);
      expect((await call(who,'GET','/code')).status).toBe(403);
      const changed=await call(who,'POST','/password',{oldPassword:INITIAL,newPassword:CHANGED});
      expect(changed.status,JSON.stringify(changed.body)).toBe(200);cookies[who]=changed.cookie!;
    }
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    expect((await call('employee','GET','/session')).status).toBe(200);
    expect((await call(null,'POST','/login',{employeeNo:people.employee!.employeeNo,password:CHANGED})).status).toBe(200);
  });
  it('厨师发布菜单，普通员工看已发布菜单；草稿和编辑权限隔离，菜单回到YuZu',async()=>{
    const body={requestId:randomUUID(),menu:menu('lunch',true)};
    expect((await call('employee','POST','/menus',body)).status).toBe(403);
    const saved=await call('chef','POST','/menus',body);expect(saved.status,JSON.stringify(saved.body)).toBe(200);
    expect((await call('chef','POST','/menus',body)).body).toEqual(saved.body);
    expect((await call('chef','POST','/menus',{requestId:randomUUID(),menu:menu('dinner',false)})).status).toBe(200);
    expect((await call('employee','GET',`/menus?date=${today}`)).body.menus).toHaveLength(1);
    expect((await call('chef','GET',`/menus?date=${today}`)).body.menus).toHaveLength(2);
    expect((await call('chef','POST','/menus',{requestId:randomUUID(),menu:{...body.menu,title:'覆盖旧版'}})).status).toBe(409);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    expect((await api(ctx.app,ctx.owner,'GET',`/api/erp/canteen/menus?date=${today}`)).body.menus).toHaveLength(2);
    const adminMenu=await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/menus',{requestId:randomUUID(),menu:menu('breakfast',true)});
    expect(adminMenu.status,JSON.stringify(adminMenu.body)).toBe(200);
    expect((await call('employee','GET',`/menus?date=${today}`)).body.menus).toHaveLength(2);
  });
  it('负责人扫码记录工号；普通员工和厨师无扫码权限；并发和重试只落一条',async()=>{
    const code=(await call('employee','GET','/code')).body.code;
    const body={requestId:randomUUID(),code};
    expect((await call('employee','POST','/checkins',body)).status).toBe(403);
    expect((await call('chef','POST','/checkins',body)).status).toBe(403);
    const pair=await Promise.all([call('manager','POST','/checkins',body),call('manager','POST','/checkins',body)]);
    expect(pair.map(r=>r.status)).toEqual([200,200]);
    expect(pair[0]!.body.checkin.id).toBe(pair[1]!.body.checkin.id);
    expect(pair[0]!.body.checkin.employeeNo).toBe(people.employee!.employeeNo);
    expect((await call('manager','POST','/checkins',{requestId:randomUUID(),code})).status).toBe(409);
    expect((await call('manager','POST','/checkins',{...body,code:'yuzu-employee:'+'a'.repeat(43)})).status).toBe(409);
    const [count]=await psql<{n:number}[]>`SELECT count(*) AS n FROM employee_checkins`;expect(count!.n).toBe(1);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    const records=await api(ctx.app,ctx.owner,'GET',`/api/erp/canteen/checkins?date=${today}`);expect(records.body.checkins).toHaveLength(1);
    expect((await call('chef','GET',`/checkins?date=${today}`)).body.checkins).toHaveLength(0);
  });
  it('拒绝伪造/过期码；已完成请求在码过期后仍能查回',async()=>{
    expect((await call('manager','POST','/checkins',{requestId:randomUUID(),code:'TEST_EMPLOYEE'})).status).toBe(400);
    const code=(await call('employee','GET','/code')).body.code;
    await psql`UPDATE employee_codes SET expires_at=now()-interval '1 minute'`;
    expect((await call('manager','POST','/checkins',{requestId:randomUUID(),code})).body.error.code).toBe('CODE_EXPIRED');
    const [old]=await psql<{requestId:string}[]>`SELECT request_id FROM employee_checkins LIMIT 1`;
    expect((await call('manager','GET',`/operations/${old!.requestId}`)).body.status).toBe('completed');
  });
  it('作废待确认请求会封住迟到写入；后台创建也有同样的fence',async()=>{
    const requestId=randomUUID(),code=(await call('employee','GET','/code')).body.code;
    expect((await call('manager','POST',`/operations/${requestId}/abandon`,{kind:'checkin'})).body.status).toBe('abandoned');
    expect((await call('manager','POST','/checkins',{requestId,code})).body.error.code).toBe('OPERATION_ABANDONED');
    const adminId=randomUUID();
    expect((await api(ctx.app,ctx.owner,'POST',`/api/erp/canteen/operations/${adminId}/abandon`,{kind:'employee_create'})).body.status).toBe('abandoned');
    expect((await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/employees',{requestId:adminId,employeeNo:'LATE',name:'迟到',departmentId,role:'employee'})).status).toBe(409);
  });
  it('操作编号不能跨后台类型串用；菜单作废先封住本地和远端，非法菜单ID不污染同步',async()=>{
    const requestId=randomUUID();
    await api(ctx.app,ctx.owner,'POST',`/api/erp/canteen/operations/${requestId}/abandon`,{kind:'employee_create'});
    expect((await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/menus',{requestId,menu:{...menu('lunch',true),date:'2031-01-10'}})).status).toBe(409);
    expect((await psql`SELECT * FROM employee_requests WHERE request_id=${requestId}`)).toHaveLength(0);
    const menuId=randomUUID();
    expect((await api(ctx.app,ctx.owner,'POST',`/api/erp/canteen/operations/${menuId}/abandon`,{kind:'menu'})).body.status).toBe('abandoned');
    expect((await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/menus',{requestId:menuId,menu:{...menu('lunch',true),date:'2031-01-11'}})).body.error.code).toBe('OP_ABANDONED');
    expect((await call('chef','POST','/menus',{requestId:randomUUID(),menu:{...menu('lunch',true),id:'not-a-uuid',date:'2031-01-12'}})).status).toBe(400);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
  });
  it('其他标签页切换账号后，旧页面声明身份与Cookie不符时不能写入',async()=>{
    const code=(await call('employee','GET','/code')).body.code;
    const r=await portal.inject({method:'POST',url:'/api/employee/checkins',headers:{origin:ORIGIN,cookie:cookies.manager,'x-employee-id':people.chef!.id},payload:{requestId:randomUUID(),code}});
    expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('ACCOUNT_CHANGED');
    const [count]=await psql<{n:number}[]>`SELECT count(*) AS n FROM employee_checkins`;expect(count!.n).toBe(1);
  });
  it('停用后同步撤销会话和已发码；网络中断超过5分钟不放行',async()=>{
    const code=(await call('employee','GET','/code')).body.code;
    const input={name:people.employee!.name,departmentId,role:'employee',active:false,version:people.employee!.version};
    expect((await api(ctx.app,ctx.owner,'PUT',`/api/erp/canteen/employees/${people.employee!.id}`,input)).status).toBe(200);
    expect((await api(ctx.app,ctx.owner,'PUT',`/api/erp/canteen/employees/${people.employee!.id}`,input)).status).toBe(200);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    expect((await call('employee','GET','/session')).status).toBe(401);
    expect((await call('manager','POST','/checkins',{requestId:randomUUID(),code})).status).toBe(400);
    await psql`UPDATE employee_sync_state SET synced_at=now()-interval '6 minutes'`;
    expect((await call('manager','GET','/code')).body.error.code).toBe('ROSTER_STALE');
    expect((await call(null,'POST','/login',{employeeNo:people.manager!.employeeNo,password:CHANGED})).body.error.code).toBe('ROSTER_STALE');
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    expect((await call('manager','GET','/session')).status).toBe(200);
  });
  it('拒绝未授权同步与倒退revision；拒绝越权的负责人部门配置',async()=>{
    expect((await portal.inject({method:'POST',url:'/internal/sync',payload:{}})).statusCode).toBe(401);
    const r=await portal.inject({method:'POST',url:'/internal/sync',headers:{'x-employee-sync-key':KEY},payload:{revision:1,canteenDepartmentId:departmentId,employees:[],afterCheckinId:0}});
    expect(r.statusCode).toBe(409);
    const [other]=await ctx.sql<{id:number}[]>`INSERT INTO departments(name) VALUES ('合成前厅') RETURNING id`;
    expect((await api(ctx.app,ctx.owner,'POST','/api/erp/canteen/employees',{requestId:randomUUID(),employeeNo:'BAD_MANAGER',name:'越权',departmentId:other!.id,role:'manager'})).status).toBe(422);
  });
  it('重置密码重放一致，同步后旧会话撤销，新的临时密码强制修改',async()=>{
    const requestId=randomUUID(),path=`/api/erp/canteen/employees/${people.manager!.id}/reset-password`;
    const first=await api(ctx.app,ctx.owner,'POST',path,{requestId});
    expect(first.status).toBe(200);
    expect((await api(ctx.app,ctx.owner,'POST',path,{requestId})).body).toEqual(first.body);
    await syncCanteen({sql:ctx.sql,config:ctx.config});
    expect((await call('manager','GET','/session')).status).toBe(401);
    expect((await call(null,'POST','/login',{employeeNo:people.manager!.employeeNo,password:CHANGED})).status).toBe(401);
    const login=await call(null,'POST','/login',{employeeNo:people.manager!.employeeNo,password:first.body.temporaryPassword});
    expect(login.status).toBe(200);expect(login.body.employee.mustChangePassword).toBe(true);
  });
});
