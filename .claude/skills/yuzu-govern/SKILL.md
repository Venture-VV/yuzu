---
name: yuzu-govern
description: 浴族 yuzu 的工程巡检：发版前或被问到「代码、文档、测试有没有越积越乱」时用。跑文档检查、治理基线、lint、秒级用例，读结果，报告哪些数字变了、哪些该收紧基线、哪些文档过期；只读，除非用户明说要改。不用于写功能、修缺陷、审某一次改动。
---

# yuzu 工程巡检

方案与规则在 `docs/GOVERNANCE.md`（第 5 节长期规则、第 8 节基线怎么用）。这里只写巡检的步骤。

## 步骤

1. 跑四条命令，都要通过（都不要数据库）：

   ```bash
   npm run lint && npm run check:docs && npm run check:gov && npm run test:unit
   ```

2. 读 `npm run check:gov` 的输出：
   - 有「比基线少了」的提示：告诉用户可以跑 `npm run check:gov -- --update` 收紧（只会调低），问过再跑。
   - 不通过：按提示改代码，**不要改基线文件来过检查**；确实要放宽的（设计工具里新加颜色之类）在 PR 说明里写原因，再 `--update --allow-increase`。
3. 文档：
   - `git diff --name-only <上一个版本标签>..HEAD -- docs/` 看这一版动了哪些文档；新加的是否进了 `docs/README.md` 的索引（`npm run check:docs -- --fix`）。
   - 这一版改了行为的模块，对应的专题文档（不是交接说明）有没有跟着改；交接说明是快照，不回头改。
   - `AGENTS.md` 离预算（24 KB）还剩多少；新规则是否写进了专题文档而不是入口。
4. 被新方案替换掉的旧函数、旧页面、旧常量是否已经删掉（`check:gov` 的「没人引用的导出」会报一部分；页面改版后没人进得去的路由要自己看）。
5. 用例：有没有新加的用例文件在 CI 里实际不会跑（`docs/TEST_AUDIT.md` 列了怎么判断）；纯计算的用例有没有不必要地引了 `tests/helpers.ts`（引了就进不了秒级一档）。

## 报告格式

- 四条命令的结果（通过 / 哪条没过、原话）。
- 与上次相比变了的数字（基线里的六样 + 约定四条）。
- 要用户拍板的事（收紧基线、放宽基线、过期文档怎么处理），一条一句，不替用户决定。

## 边界

- 只读：不删文件、不改基线、不动业务代码，除非用户明说。
- 不碰小程序线的目录（`miniprogram/`、`src/gateway/`、`src/server/modules/mp/`、`src/client/features/mp/`、`src/shared/mp.ts`）。
- 不跑全量 `npm test`、不跑浏览器验收（那是门禁，不是巡检）。
