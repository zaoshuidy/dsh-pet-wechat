# dsh-pet V0.1 施工契约（唯一接口标准）

所有人先读本文件 + `D:\dsh\pet-min-spec.md`。只写自己名下的文件，不改别人的。

## 运行环境
- Node 24（宿主 runtime），ESM（`package.json` `"type":"module"`），**零第三方依赖**，用 `node:sqlite` 的 `DatabaseSync`。
- Windows 路径；不要 TypeScript；不要联网（测试用 mock）。
- 代码短、直白、可读，单文件 ≤250 行。

## 文件归属

| 负责人 | 文件 |
|---|---|
| store | `src/store/schema.sql`、`src/store/db.js`、`package.json` |
| affect | `src/modules/affect.js` |
| style | `src/modules/style.js` |
| memory | `src/modules/memory.js`、`src/modules/graph.js`、`src/modules/retrieve.js` |
| assembler | `src/modules/persona.js`、`src/core/prompt.js`、`src/core/llm.js`、`src/index.js`、`src/channel/dev.js`、`cli.js` |
| verifier | `test/smoke.mjs` |

## 表结构（照抄，不得改字段名）

```sql
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS persons (
  contact_id TEXT PRIMARY KEY, name TEXT, traits TEXT, likes TEXT, dislikes TEXT,
  affection REAL DEFAULT 20, mood REAL DEFAULT 50, energy REAL DEFAULT 50,
  emotion TEXT DEFAULT '{}', stage INTEGER DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, contact_id TEXT, type TEXT, name TEXT,
  aliases TEXT DEFAULT '[]', attrs TEXT DEFAULT '{}', importance REAL DEFAULT 1, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, contact_id TEXT, src TEXT, dst TEXT, rel TEXT, weight REAL DEFAULT 1,
  valid_from INTEGER, valid_to INTEGER, source_memory TEXT, confidence REAL DEFAULT 0.6);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, contact_id TEXT, level INTEGER DEFAULT 1, parent_id TEXT,
  title TEXT, gist TEXT, detail TEXT, topics TEXT DEFAULT '[]', people TEXT DEFAULT '[]',
  valence REAL DEFAULT 0, arousal REAL DEFAULT 0, importance REAL DEFAULT 3, strength REAL DEFAULT 1,
  ts INTEGER, last_access INTEGER, access_count INTEGER DEFAULT 0, detail_level INTEGER DEFAULT 2);
CREATE TABLE IF NOT EXISTS mem_entities (memory_id TEXT, entity_id TEXT, PRIMARY KEY (memory_id, entity_id));
CREATE TABLE IF NOT EXISTS embeddings (owner_type TEXT, owner_id TEXT, vec TEXT, model TEXT, PRIMARY KEY (owner_type, owner_id));
CREATE TABLE IF NOT EXISTS style (contact_id TEXT, dim TEXT, base REAL, min REAL, max REAL, current REAL, updated_at INTEGER, PRIMARY KEY (contact_id, dim));
CREATE TABLE IF NOT EXISTS style_terms (contact_id TEXT, term TEXT, count INTEGER, first_seen INTEGER, last_seen INTEGER, PRIMARY KEY (contact_id, term));
```

## 模块接口（导出名、参数、返回必须一致）

```js
// store/db.js
export function openDb(file);            // -> DatabaseSync（自动 mkdir）
export function migrate(db);             // 执行 schema.sql；meta.schema_version=1
export const now = () => Date.now();

// modules/affect.js
export function createAffect(db);
  .ensure(contactId)                     // 建 persons 行
  .tick(contactId, at)                   // 衰减：mood 向 baseline，emotion 向 mood
  .get(contactId)                        // -> {mood,energy,affection,stage,emotion:{label,intensity},updatedAt}
  .apply(contactId, deltas, reason)      // deltas:{mood?,energy?,affection?} 钳制 ±20/轮，0..100
  .setEmotion(contactId, label, intensity)
  .manner(contactId)                     // -> {register:{closeness,initiative,formality},texture:{sentenceLen,emoji,particles,punctuation}}
  .describe(contactId)                   // -> 中文一句（≤60字），给 prompt

// modules/style.js
export function createStyle(db);
  .observe(contactId, text)              // 统计并漂移；返回 {dims,terms}
  .current(contactId)                    // -> {dims:{sentenceLen,emoji,particles,punct,initiative,formality},terms:[...]}
  .register(contactId)                   // -> {sentenceLen,emoji,particles,punct,initiative,formality,terms}
  .seed(contactId, {base})               // 初始化 base/min/max，min=base*0.9,max=base*1.1

// modules/memory.js
export function createMemory(db);
  .write(contactId, rec)                 // rec:{episode,people[],topics[],valence,arousal,importance,detail?,facts[],entities[],relations[]}
                                         // -> {id, entityIds, edgeIds}
  .recall(contactId, text, opts)         // -> {items:[{id,gist,score,level}], facts:[{key,value}]}
  .expand(contactId, id)                 // -> {detail, gist}
  .decay(contactId, at)                  // 7/30/180 天规则；返回处理条数

// modules/graph.js
export function createGraph(db);
  .upsertEntity(contactId, e)            // e:{type,name,aliases?,attrs?} -> entityId（按 name 去重）
  .link(contactId, src, dst, rel, o)     // o:{weight?,source?,validFrom?} -> edgeId
  .neighbors(contactId, entityId, hops)  // -> [{id,weight,path}]
  .findByAlias(contactId, text)          // -> [{id,name,type}]

// modules/retrieve.js
export function createRetriever({db, graph});
  .search(contactId, text, {limit=3})    // 关键词 BM25 + tf-idf 余弦 + 图扩展 + RRF
                                         // -> [{id,gist,score,why}]

// modules/persona.js
export function loadPersona(file);       // 读 md/json，返回对象
export function renderPersona(p);        // -> 中文段落字符串

// core/prompt.js
export function buildPrompt({persona, register, texture, affectText, memories, facts, history, text});
                                         // -> [{role:'system'|'user'|'assistant',content}]

// core/llm.js
export function createLlm(cfg);          // cfg:{mode:'mock'|'api', baseURL?, apiKey?, model?}
  .chat(messages)                        // -> string（原文，可能含 [state]/[memory] 块）

// index.js
export function createPet({dbFile, personaFile, llm});  // -> {handle(contactId,text)->{reply,state,memoryIds}}
```

## 模型输出协议（llm 返回的原文）

```
正常回复正文
[state]{"mood":+6,"energy":-2,"affection":+1}[/state]
[memory]{"episode":"...","people":[],"topics":[],"valence":0.3,"arousal":0.5,"importance":3,
         "entities":[{"type":"person","name":"老周"}],"relations":[],"facts":[]}[/memory]
```
- 发送前必须剥掉两个块；解析失败忽略该块。
- mock 模式固定返回带两个块的文本，保证测试可断言。

## 验收（verifier 负责）

`npm test` 必须全绿（五个套件）：
1. `test/unit-memory.mjs`：图/事实/写入/衰减/调度/展开/预算/短对话/缓存/召回/估算
2. `test/unit-affect.mjs`：state 生效（含精力下降、好感可降）、情绪标签、坏 JSON 兜底
3. `test/smoke.mjs`：建库、三轮对话、记忆/实体/风格、漂移不越界
4. `test/extreme.mjs`：空/超长/注入输入、并发、强压、模型异常、情绪边界、隔离、联动、持久化
5. `test/resilience.mjs`：断线、SIGKILL、重启后 integrity=ok、记忆不回退、心情不重置

补充约定（评审后）：
- 模型 `state` 照单全收，但单轮钳制：mood ∈ [-6,+3]，energy 减半且 ∈ [-5,+1]，affection 原值；中性/难过的回合不接受正向 mood。
- 情绪标签由 valence 推导（开心/松快/平静/有点闷/低落），强度按 |valence|；
- 衰减在启动时跑一次，之后每 30 分钟一次，跑完让缓存失效；
- L2 章节合并暂缓（30 天只翻 level/detail_level），在里程碑里注明；规则实体抽取仍未实现。

## 明确不做

不接 DSH、不接微信、不做界面、不做 embedding API、不引第三方库、不写 TS。
