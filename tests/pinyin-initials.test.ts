// 拼音首字母与技师搜索（8.1.15，docs/TECHNICIANS_V8115.md 第 2 节）：不连数据库。
// 钟房打「zxm」找到「张小明」；姓名、花名、工号都能找；叫号念的那一句。

import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeQuery, pinyinInitials } from '../src/shared/pinyin-initials';
import { announceText, matchesTechnician, parseClock, servesCategory, shiftTimeText } from '../src/shared/technician-admin';

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

  it('班次：起止时间的写法，结束不晚于开始是到次日', () => {
    expect(shiftTimeText({ startMinute: 600, endMinute: 1080 })).toBe('10:00–18:00');
    expect(shiftTimeText({ startMinute: 1080, endMinute: 120 })).toBe('18:00–次日 02:00');
    expect(parseClock('9:30')).toBe(570);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });
});
