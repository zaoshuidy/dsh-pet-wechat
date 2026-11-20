# 小满 · DeepSeek Harness 微信宠物

把「人设 + 人味 + 情绪/记忆 + 表情包 + 微信通道」打包成一个 DSH 插件，装一次就能在微信里聊。

> 不是助手，是住在微信里的朋友：会学你说话、有情绪、记得住旧事。

## 它是什么

一个 DeepSeek Harness（DSH）bundle。安装后：

- **微信通道**：复用 [`@michengai/dsh-im-connect`](https://www.npmjs.com/package/@michengai/dsh-im-connect)，走腾讯官方 iLink，扫码登录，仅私聊
- **表情包**：复用 [`dsh-meme`](https://www.npmjs.com/package/dsh-meme) 的图库与 `send_meme` 工具
- **人设与人味**：本仓库注入的系统提示词段（短句、口语、不列清单、不客服腔）
- **记忆**：三个工具 `pet_remember` / `pet_recall` / `pet_rotate`，配 SQLite 长期库

## 功能

| 能力 | 说明 |
|---|---|
| 跨对话记忆 | 事件、事实、喜好、关系四类，按话题混合召回（图 + 关键词 + 向量，RRF 融合） |
| 强制压缩 | 上下文到 256K（可调）自动归档：写一条 `kind:handoff` 交接记忆，下条消息开新会话 |
| 空闲做梦 | 45 分钟没动静，把同话题 ≥3 条的零散事件合并成 `kind:dream`，并做衰减 |
| 情绪四层 | 秒级情绪 → 小时级心情 → 长期好感 → 固定性格；数值插件维护，模型只能给变化量 |
| 性格漂移 | 句长、emoji、语气词等 6 维，±10% 内向对方靠拢，长期不聊回弹 |
| 人味规则 | 1–3 句、不寒暄不总结、像微信打字、不每句反问 |

## 目录

```
packages/
  core/      # 记忆 / 情绪 / 性格 / 检索 / 上下文预算，带 40 个测试
  plugin/    # DSH bundle：人设段 + 三个记忆工具 + 依赖声明
docs/
  DESIGN.md  # 设计稿（四层情感、关系图 + RAG、渐进披露）
```

`packages/plugin/core/` 是 `packages/core/src` 的副本，供插件独立加载；改完核心记得同步。

## 安装

1. 先装 DSH，确认版本 ≥ 0.2.2。
2. 插件页 → Add plugin → 选本仓库的 `packages/plugin` 目录。
3. 重启 DSH。
4. 设置 → IM 助理 → 添加账号 → 微信 → 扫码（手机微信需有 ClawBot 入口）。

## 微信侧限制

- **只能私聊**：iLink 机器人不能进群、没有 @ 事件。
- **不能主动冷启动**：对方没说过话之前，它发不出消息。
- **表情包以图片发出**：协议没有原生贴纸类型。
- **上下文 256K 可能大于模型窗口**：若模型只支持 128K，把 `PET_CONTEXT_LIMIT` 调小。

## 配置（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `PET_DB_FILE` | `~/.dsh/pet/pet.db` | 记忆库路径 |
| `PET_CONTACT` | `owner` | 记忆归属人（单用户） |
| `PET_CONTEXT_LIMIT` | `256000` | 触发归档的 token 上限 |
| `PET_ROTATE_AT` | `30` | 写入多少次后软提醒归档 |

## 测试

`packages/core` 下：

```bash
npm test
```

覆盖：记忆读写/衰减/展开、情绪边界与联动、表情挑选、跨会话持久化、两种压缩、断线硬杀重启。

## 第三方与许可

- 本仓库代码：MIT
- `@michengai/dsh-im-connect`：Apache-2.0（运行时依赖，不随仓库分发）
- `dsh-meme`：MIT（运行时依赖）
- 内置「大肥鱼」表情图库：**未包含**（原图库为 personal 授权，不随仓库分发）；请自行放入图库目录
