// 拼音首字母与技师搜索（8.1.15，docs/TECHNICIANS_V8115.md 第 2 节）：不连数据库。
// 钟房打「zxm」找到「张小明」；姓名、花名、工号都能找；叫号念的那一句。

import { describe, expect, it } from 'vitest';
import { EMPTY_TECH_QUERY, filterBoardTechnicians, sortBoardTechnicians, techQueryActive, type BoardTechnician, type TechQuery } from '../src/shared/clockroom';
import { matchesQuery, normalizeQuery, pinyinInitials } from '../src/shared/pinyin-initials';
import { announceText, matchesTechnician, parseClock, servesCategory, shiftTimeText, spokenText } from '../src/shared/technician-admin';

describe('拼音首字母', () => {
  it('常见的名字：每个字取声母', () => {
    expect(pinyinInitials('张小明')).toBe('zxm');
    expect(pinyinInitials('小雅')).toBe('xy');
    expect(pinyinInitials('欧阳娜娜')).toBe('oynn');
    expect(pinyinInitials('李婷')).toBe('lt');
  });

  it('二十三个声母各取一批常见的字，分界上的字也对', () => {
    const samples: Record<string, string> = {
      a: '阿安艾爱昂傲吖',
      b: '八白包北贝毕冰波',
      c: '蔡曹陈程崔春翠擦',
      d: '大戴邓丁董杜段朵',
      e: '鄂娥恩儿二尔',
      f: '发范方芳冯凤傅',
      g: '高葛龚顾郭桂国',
      h: '哈韩郝何贺红胡黄慧',
      j: '吉贾姜蒋金静娟君',
      k: '卡康柯孔匡坤',
      l: '拉赖兰雷李丽梁林刘龙卢陆吕罗玲',
      m: '妈马麦毛梅孟米苗敏明莫穆',
      n: '拿娜南倪聂宁牛农',
      o: '噢哦欧偶',
      p: '潘庞裴彭皮平蒲',
      q: '七齐钱强乔秦琴邱琪',
      r: '然冉任荣茹阮瑞',
      s: '撒桑沙邵沈盛石史舒宋苏孙',
      t: '他谭汤唐陶田婷童涂',
      w: '挖万汪王韦魏文翁吴武',
      x: '夕席夏项萧小谢辛邢熊徐许薛霞',
      y: '丫雅燕严杨姚叶易尹于余袁岳云',
      z: '匝詹张赵郑钟周朱庄卓邹左',
    };
    for (const [letter, chars] of Object.entries(samples)) {
      for (const ch of chars) expect(pinyinInitials(ch), `「${ch}」`).toBe(letter);
    }
  });

  it('字母、数字原样（小写），空格与符号丢掉；空字符串是空的', () => {
    expect(pinyinInitials('Amy 小雅 08')).toBe('amyxy08');
    expect(pinyinInitials('小·雅（A12）')).toBe('xya12');
    expect(pinyinInitials('')).toBe('');
    expect(pinyinInitials('！？—')).toBe('');
  });
});

describe('搜索', () => {
  it('原文包含或首字母包含都算；搜索词去掉空白、不分大小写', () => {
    expect(normalizeQuery(' Z x M ')).toBe('zxm');
    expect(matchesQuery('zxm', ['张小明'])).toBe(true);
    expect(matchesQuery('xm', ['张小明'])).toBe(true);
    expect(matchesQuery('小明', ['张小明'])).toBe(true);
    expect(matchesQuery('zxl', ['张小明'])).toBe(false);
    expect(matchesQuery('', ['张小明'])).toBe(true);
    expect(matchesQuery('a', ['', ''])).toBe(false);
  });

  it('技师：姓名、花名、工号，以及姓名、花名的首字母', () => {
    const t = { name: '张小明', nickname: '小雅', techNo: 'A18' };
    for (const q of ['张', '小雅', 'zxm', 'xy', 'a18', '18']) expect(matchesTechnician(normalizeQuery(q), t), q).toBe(true);
    for (const q of ['李', 'lt', '19']) expect(matchesTechnician(normalizeQuery(q), t), q).toBe(false);
    // 没有花名的只按姓名、工号
    expect(matchesTechnician('xy', { name: '张小明', nickname: '', techNo: '08' })).toBe(false);
  });

  it('可做项目：没设分类的什么都做', () => {
    expect(servesCategory({ skills: [] }, '足疗')).toBe(true);
    expect(servesCategory({ skills: ['足疗'] }, '足疗')).toBe(true);
    expect(servesCategory({ skills: ['足疗'] }, '按摩')).toBe(false);
  });
});

describe('叫号念的那一句、班次的时间', () => {
  it('排位号 + 工号 + 花名（没有花名念名字）+ 房间；不在队列里的不念排位号，不知道房间的念「准备上钟」', () => {
    expect(announceText({ position: 3, techNo: '18', name: '张小雅', nickname: '小雅', room: '201 房' })).toBe('请 3 号排位，18 号 小雅，到 201 房');
    expect(announceText({ position: null, techNo: '18', name: '张小雅', nickname: '', room: 'S301 SPA 一号' })).toBe('请 18 号 张小雅，到 S301 SPA 一号');
    expect(announceText({ position: 1, techNo: '08', name: '小李', nickname: '', room: null })).toBe('请 1 号排位，08 号 小李，准备上钟');
  });

  it('交给朗读引擎的写法：三位以上的数字一位一位念，排位号、工号照常', () => {
    expect(spokenText('请 3 号排位，18 号 小雅，到 201 房')).toBe('请 3 号排位，18 号 小雅，到 二零一 房');
    expect(spokenText('请 12 号排位，08 号 小李，到 S3105 SPA 一号')).toBe('请 12 号排位，08 号 小李，到 S三一零五 SPA 一号');
  });

  it('班次：起止时间的写法，结束不晚于开始是到次日', () => {
    expect(shiftTimeText({ startMinute: 600, endMinute: 1080 })).toBe('10:00–18:00');
    expect(shiftTimeText({ startMinute: 1080, endMinute: 120 })).toBe('18:00–次日 02:00');
    expect(parseClock('9:30')).toBe(570);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });
});

describe('钟房的筛选与排序', () => {
  type T = Pick<BoardTechnician, 'active' | 'name' | 'nickname' | 'techNo' | 'kind' | 'skills' | 'suspendedAt' | 'busy' | 'state' | 'position'>;
  const tech = (techNo: string, name: string, patch: Partial<T> = {}): T => ({
    active: true,
    name,
    nickname: '',
    techNo,
    kind: '',
    skills: [],
    suspendedAt: null,
    busy: null,
    state: 'off',
    position: null,
    ...patch,
  });
  const list: T[] = [
    tech('11', '张小明', { nickname: '小雅', kind: '足浴', skills: ['足疗'], state: 'on', position: 2 }),
    tech('12', '李婷', { kind: '按摩', skills: ['身体护理'], state: 'on', position: 1, busy: { sessionId: 1, status: 'serving' } }),
    tech('13', '王芳', { kind: '足浴', state: 'leave' }),
    tech('14', '赵敏', { state: 'on', position: 3, busy: { sessionId: 2, status: 'waiting' } }),
    tech('2', '周琪', { kind: 'SPA', state: 'rest' }),
    tech('A5', '郑爽', { kind: '足浴', suspendedAt: '2026-11-19T02:00:00.000Z' }),
    tech('15', '钱多', { active: false, kind: '足浴' }),
  ];
  const nos = (q: Partial<TechQuery>) => filterBoardTechnicians(list, { ...EMPTY_TECH_QUERY, ...q }).map((t) => t.techNo);

  it('没有条件：在职的都在；停用的不在', () => {
    expect(techQueryActive(EMPTY_TECH_QUERY)).toBe(false);
    expect(techQueryActive({ ...EMPTY_TECH_QUERY, text: '  ' })).toBe(false);
    expect(nos({})).toEqual(['11', '12', '13', '14', '2', 'A5']);
  });

  it('搜索：姓名、花名、工号、拼音首字母', () => {
    expect(nos({ text: 'zxm' })).toEqual(['11']);
    expect(nos({ text: 'XY' })).toEqual(['11']);
    expect(nos({ text: '婷' })).toEqual(['12']);
    expect(nos({ text: 'a5' })).toEqual(['A5']);
    expect(nos({ text: 'z' })).toEqual(['11', '14', '2', 'A5']);
    expect(techQueryActive({ ...EMPTY_TECH_QUERY, text: 'z' })).toBe(true);
  });

  it('类型、项目、状态可以叠加；同一样里多选是「任一样」；没设可做分类的什么项目都算', () => {
    expect(nos({ kinds: ['足浴'] })).toEqual(['11', '13', 'A5']);
    expect(nos({ kinds: ['足浴', 'SPA'] })).toEqual(['11', '13', '2', 'A5']);
    expect(nos({ kinds: [''] })).toEqual(['14']);
    expect(nos({ categories: ['身体护理'] })).toEqual(['12', '13', '14', '2', 'A5']);
    expect(nos({ categories: ['足疗'], kinds: ['足浴'] })).toEqual(['11', '13', 'A5']);
    expect(nos({ categories: ['足疗'], kinds: ['足浴'], status: 'idle' })).toEqual(['11']);
    expect(nos({ kinds: ['足浴'], status: 'leave', text: 'wf' })).toEqual(['13']);
    expect(nos({ kinds: ['足浴'], status: 'serving' })).toEqual([]);
  });

  it('排序：按排位（队列里的按位置，其余按工号——数字工号按数值）；按状态是空闲、上钟、已派待上、休息、休假、停牌', () => {
    expect(sortBoardTechnicians(list.slice(0, 6), 'queue').map((t) => t.techNo)).toEqual(['12', '11', '14', '2', '13', 'A5']);
    expect(sortBoardTechnicians(list.slice(0, 6), 'status').map((t) => t.techNo)).toEqual(['11', '12', '14', '2', '13', 'A5']);
  });
});
