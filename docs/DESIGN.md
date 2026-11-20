# dsh-pet 最小格式 v1（已锁定）

四层情感 + 关系图/RAG 混合记忆 + 性格漂移。单包、SQLite、1 次模型调用/轮。

## 0. 已定决策

| 项 | 结论 |
|---|---|
| 情绪表示 | 离散 6–8 个 + 强度（0–100），映射到 PAD 只用于排序 |
| 情感维度 | 单一好感 0–100 + 关系阶段（陌生/熟悉/亲近/依赖） |
| 细节原文 | 只存一句关键原话，不存整段 |
| 性格漂移 | ±10%，口癖最多 5 个 |
| 检索 | 关键词 + 向量混合（RRF 融合） |
| 实体抽取 | 规则 + 别名表先跑，模型兜底可关 |
| 渐进披露 | L3 常驻 → L1 gist → L0 按需展开 |
| 素材 | 作废不删（valid_to），只追加 |

## 1. 情感四层

```
性格(固定) → 情感(对人, 周-月) → 心情(分-时) → 情绪(秒)
```

```js
心情基线 = 性格基线 + 0.2 * (情感 - 50)
心情  += (基线 - 心情) * (1 - exp(-Δt/2h))
情绪  *= exp(-Δt/30s)          // 衰减余量并入心情
情感  += 0.05 * (事件感受 - 情感)   // 半衰 30 天
```

语气拆分：
```
register = 性格 + 漂移 + 情感   // 称呼、距离、主动、容忍
texture  = 心情 + 情绪          // 句长、标点、emoji、语气词、间隔
```

## 2. 存储

```sql
persons(contact_id PK, name, traits, likes, dislikes, affection, stage, updated_at)

entities(id PK, contact_id, type, name, aliases, attrs, importance, last_seen)
edges(id PK, contact_id, src, dst, rel, weight,
      valid_from, valid_to, source_memory, confidence)

memories(id PK, contact_id, level INT, parent_id,
         title, gist, detail, topics, people,
         valence, arousal, importance, strength,
         ts, last_access, access_count, detail_level)

mem_entities(memory_id, entity_id, PRIMARY KEY(memory_id, entity_id))
embeddings(owner_type, owner_id, vec BLOB, model, PRIMARY KEY(owner_type, owner_id))

style(contact_id, dim, base, min, max, current, updated_at,
      PRIMARY KEY(contact_id, dim))
style_terms(contact_id, term, count, first_seen, last_seen,
            PRIMARY KEY(contact_id, term))

meta(k PK, v)
```

level：3 画像 / 2 章节 / 1 事件 / 0 细节。detail_level：3 原文 / 2 摘要 / 1 关键词 / 0 标签。

## 3. 检索（三路召回 + RRF）

```
q = 当前消息 + 最近 2 轮
① 实体：别名精确/前缀命中 → 1–2 跳扩边（第 2 跳 ×0.6）
② 关键词：gist/ detail 的 BM25
③ 向量：tf-idf 余弦（默认）或 /embeddings（config 切换）
→ RRF: score = Σ 1/(60+rank)
→ 偏置: +0.15*new + 0.15*importance + 0.10*mood + 0.10*person
→ 取前 3 条 gist（≤40 字/条）
→ 满足任一条件才展开 L0：用户问“哪天/哪/谁/具体”，或模型请求
```

预算：L3 120 token + L1 120 token + 关系事实 100 token ≈ 340。

## 4. 衰减与巩固

```
衰减速率 = base / (1 + importance + strength)
strength += 1   // 命中一次
7 天未访问：L0 压缩成摘要（重要度高的留 1 句原话）
30 天：L1 合并进 L2 章节，只留 gist
180 天：只留 topics
```

## 5. 性格漂移（±10%）

维度：句长、emoji、语气词、标点、主动度、正式度；口癖单独表（≤5）。

```js
current += 0.02 * (observed - current)
current = clamp(current, base*0.9, base*1.1)
if (|observed-current| < 0.05) 不动
// 7 天不聊：每天回 0.01
```

观测全是确定性统计（平均句长、emoji 计数、词表命中），不花 token。

## 6. 实体抽取（规则优先）

1. 别名表：person/place/thing 的名字 + 别名。
2. 句式规则：`我(也)?(喜欢|讨厌|养|住|在|叫|是)X`、`X(是|叫)Y`、`和X一起`。
3. 候选清洗：去停用词、长度 2–8、出现 ≥1 次。
4. `extract.llm=false` 时到此为止；true 时用 `[memory].entities` 兜底。

## 7. 一轮契约

```
in  {contactId, text}
1  style.observe(text)                  // 更新漂移
2  affect.tick(now)                     // 衰减
3  recall(contactId, text)              // 三路召回 + RRF
4  prompt(persona, register, texture, memories, facts)
5  llm(messages) → raw + [state] + [memory]
6  affect.apply(deltas) / memory.write(episode, entities, edges, facts)
7  speech.render(raw) → [{text, delayMs}]   // 默认原样单条
8  channel.send
```

`[state]`：`{"mood":+6,"energy":-2,"closeness":+3}`
`[memory]`：`{"episode":"...","people":[],"topics":[],"valence":-0.4,"arousal":0.6,
"importance":3,"entities":[],"relations":[],"facts":[]}`

## 8. 模块接口

```js
affect.get(contactId) / tick(now) / apply(deltas) / manner(contactId)
memory.recall(contactId, text) / write(record) / expand(memoryId)
graph.upsertEntity(e) / link(src, dst, rel, opts) / neighbors(id, hops)
style.observe(contactId, text) / current(contactId) / register(contactId)
speech.register(provider)   // 默认 passthrough
```

## 9. 里程碑

| 版本 | 内容 | 验收 |
|---|---|---|
| V0.1 | 建表 + 性格漂移 + 人设注入 + dev 通道 | curl 能聊，语气随我变 |
| V0.2 | L1 事件 + BM25 检索 + `[memory]` 写入 | 隔天记得住 |
| V0.3 | 实体/边 + 图扩展 + 向量混合 | “气球”能联到“游乐园” |
| V0.4 | L0 展开 + 衰减任务 | 细节按需出现，旧事只留标签 |

## 10. 配置

```yaml
stateDir: ~/.dsh/dsh-pet
embedding: local        # local | api
extract: rules          # rules | llm
styleDrift: 0.10
memoryBudget: 400
detailExpand: on-demand
```
