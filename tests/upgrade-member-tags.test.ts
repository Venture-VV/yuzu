// 迁移 088（8.0.4 会员体系整改，docs/MEMBERSHIP_V804.md 第 2、3、5 节）在 8.0.3 的库上升级：
//   · 自定义字段全部转成标签：字段名做分组，单选的可选值都建好，每个填过的值都有标签、填过的会员都挂上（需求表 05「历史字段值全部转标签无丢失」）；
//     文字两端的空白去掉；停用的字段转成停用的标签；两个字段名字相同、值相同的合成一个标签，两边的会员都挂上；原来的 custom_fields 原样不动；
//   · VIP 柜设置从会员规则、手牌与前台搬到 vip_locker_rules（值原样），原来两份设置里不再有；
//   · 次卡停售（count_card_sales = false）。

import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/server/auth/password';
import { createSql, type Sql } from '../src/server/db';
import { migrate } from '../src/server/migrate';
import { PASSWORD, TEST_DB } from './helpers';
import { resetPublicSchema } from './test-db';

const MIGRATIONS = new URL('../src/server/migrations/', import.meta.url);
/** 8.0.4 新加的迁移：8.0.3 的库里没有（090–093 在 8.0.3 之前已发布） */
const NEW_IN_804 = ['088_member_tags_vip.sql', '089_coupon_campaigns.sql', '094_coupon_campaign_ops.sql', '095_sms_outbox_lease.sql'];
let sql: Sql;

beforeAll(() => {
  sql = createSql(TEST_DB, { max: 4 });
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** 新建一个 8.0.3 的库（除了 8.0.4 新加的迁移都执行过） */
async function schemaAt803() {
  await resetPublicSchema(sql);
  await sql`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const f of (await readdir(MIGRATIONS)).filter((x) => x.endsWith('.sql') && !NEW_IN_804.includes(x)).sort()) {
    await sql.unsafe(await readFile(new URL(f, MIGRATIONS), 'utf8'));
    await sql`INSERT INTO schema_migrations (version) VALUES (${f})`;
  }
}

const FIELDS = [
  { key: 'f1', label: '车牌号', type: 'text', options: [], required: false, active: true },
  { key: 'f2', label: '了解渠道', type: 'select', options: ['朋友介绍', '美团', '路过'], required: false, active: true },
  { key: 'f3', label: '鞋码', type: 'number', options: [], required: false, active: true },
  { key: 'f4', label: '纪念日', type: 'date', options: [], required: false, active: false },
  // 与 f2 同名的另一个字段（店里先后建过两次）：值相同的合成一个标签，两边的会员都挂上
  { key: 'f5', label: '了解渠道', type: 'text', options: [], required: false, active: true },
];

describe('迁移 088 · 自定义字段转标签、VIP 柜设置搬家、次卡停售', () => {
  it('历史字段值全部转成标签、一个不丢；原值不动；VIP 柜设置原样搬过来；次卡停售', async () => {
    await schemaAt803();
    const hash = await hashPassword(PASSWORD);
    await sql`INSERT INTO staff (username, display_name, role, password_hash) VALUES ('owner', '店主', 'owner', ${hash})`;
    await sql`INSERT INTO settings (key, value) VALUES ('member_fields', ${sql.json(FIELDS)})`;
    await sql`
      INSERT INTO settings (key, value) VALUES
        ('membership_rules', ${sql.json({ firstRechargeMinCents: 0, vipLockerLevels: [0, 1, 1, 2, 2, 4, 5] })}),
        ('frontdesk_rules', ${sql.json({ vipOverrideEnabled: true })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    const values: Record<string, Record<string, string | number>> = {
      甲: { f1: '沪A12345', f2: '美团', f3: 42 },
      乙: { f1: ' 沪A12345 ', f2: '朋友介绍', f4: '2020-05-20' },
      丙: {},
      丁: { f2: '已经删掉的选项', f1: '' },
      戊: { f5: '美团', f3: 42.5 },
    };
    const ids: Record<string, number> = {};
    let n = 0;
    for (const [name, custom] of Object.entries(values)) {
      n += 1;
      const [m] = await sql<{ id: number }[]>`
        INSERT INTO members (member_no, name, phone, custom_fields) VALUES (${`YZ0${1000 + n}`}, ${name}, ${`1390000${String(n).padStart(4, '0')}`}, ${sql.json(custom)})
        RETURNING id`;
      ids[name] = Number(m!.id);
    }

    await migrate(sql);

    const tags = await sql<{ groupName: string; name: string; source: string; active: boolean }[]>`
      SELECT group_name, name, source, active FROM member_tags ORDER BY group_name, name`;
    const label = (t: { groupName: string; name: string }) => `${t.groupName}/${t.name}`;
    expect(tags.map(label).sort()).toEqual(
      ['客群/亲子客', '客群/商务客', '车牌号/沪A12345', '了解渠道/朋友介绍', '了解渠道/美团', '了解渠道/路过', '了解渠道/已经删掉的选项', '鞋码/42', '鞋码/42.5', '纪念日/2020-05-20'].sort(),
    );
    // 停用的字段转成停用的标签
    expect(tags.find((t) => t.groupName === '纪念日')!.active).toBe(false);
    expect(tags.filter((t) => t.source === 'field')).toHaveLength(8);

    const linked = async (name: string) =>
      (
        await sql<{ groupName: string; name: string }[]>`
          SELECT t.group_name, t.name FROM member_tag_links l JOIN member_tags t ON t.id = l.tag_id WHERE l.member_id = ${ids[name]!}`
      )
        .map(label)
        .sort();
    expect(await linked('甲')).toEqual(['了解渠道/美团', '车牌号/沪A12345', '鞋码/42'].sort());
    expect(await linked('乙')).toEqual(['了解渠道/朋友介绍', '纪念日/2020-05-20', '车牌号/沪A12345'].sort());
    expect(await linked('丙')).toEqual([]);
    expect(await linked('丁')).toEqual(['了解渠道/已经删掉的选项']);
    expect(await linked('戊')).toEqual(['了解渠道/美团', '鞋码/42.5'].sort());

    // 无丢失：每位会员的每个填过的值，都挂着「字段名 / 值」的标签
    const [missing] = await sql<{ n: number }[]>`
      WITH defs AS (
        SELECT d->>'key' AS key, d->>'label' AS label
        FROM settings s CROSS JOIN LATERAL jsonb_array_elements(s.value) AS t(d) WHERE s.key = 'member_fields'
      )
      SELECT count(*)::int AS n
      FROM members m JOIN defs d ON m.custom_fields ? d.key
      WHERE btrim(m.custom_fields->>d.key) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM member_tag_links l JOIN member_tags t ON t.id = l.tag_id
          WHERE l.member_id = m.id AND t.group_name = d.label AND t.name = btrim(m.custom_fields->>d.key))`;
    expect(missing!.n).toBe(0);
    // 原来的值原样留着
    const [kept] = await sql<{ customFields: Record<string, unknown> }[]>`SELECT custom_fields FROM members WHERE id = ${ids['乙']!}`;
    expect(kept!.customFields).toEqual(values['乙']);

    // VIP 柜：原样搬过来，原来两份设置里不再有
    const settings = Object.fromEntries((await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM settings`).map((r) => [r.key, r.value]));
    expect(settings.vip_locker_rules).toEqual({ levels: [0, 1, 1, 2, 2, 4, 5], overrideEnabled: true });
    expect(settings.membership_rules).not.toHaveProperty('vipLockerLevels');
    expect(settings.membership_rules).toMatchObject({ firstRechargeMinCents: 0 });
    expect(settings.frontdesk_rules).not.toHaveProperty('vipOverrideEnabled');
    expect(settings.count_card_sales).toBe(false);

    // 标签不能删、来源不能改
    await expect(sql`DELETE FROM member_tags WHERE name = '美团'`).rejects.toThrow(/不能删除/);
    await expect(sql`UPDATE member_tags SET source = 'manual', field_key = NULL WHERE name = '美团'`).rejects.toThrow(/不能改/);
  });

  it('没配过自定义字段、没设过 VIP 柜的库：只有两个客群标签，VIP 柜按默认', async () => {
    await schemaAt803();
    await migrate(sql);
    expect((await sql<{ name: string }[]>`SELECT name FROM member_tags ORDER BY sort_order`).map((t) => t.name)).toEqual(['亲子客', '商务客']);
    const [vip] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'vip_locker_rules'`;
    expect(vip!.value).toEqual({ levels: [1, 1, 1, 1, 2, 4, 5], overrideEnabled: false });
  });
});
