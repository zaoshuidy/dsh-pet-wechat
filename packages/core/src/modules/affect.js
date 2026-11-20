/**
 * modules/affect.js — 四层情感里的「情感 / 心情 / 情绪」三层
 *
 * 状态全部落在 persons 表的列里：mood / energy / affection / emotion(JSON) / stage / updated_at。
 * updated_at 既是「上次结算时间」，也是情绪、心情衰减的 dt 基准。
 *
 * 规则（CONTRACT.md + pet-min-spec.md §1）：
 *   baseline   = 50 + 0.2 * (affection - 50)
 *   mood      += (baseline - mood) * (1 - exp(-dt / 2h))      // 心情回基线
 *   emotion   *= exp(-dt / 30s)，衰减掉的强度 * 0.3 并入 mood  // 情绪 30s 衰减
 *   affection += 0.05 * (target - affection)                  // EMA，target = affection + Δ*5
 *   apply 每轮每轴 |Δ| ≤ 20，结果一律 0..100
 *   stage: <20 = 0，20..44 = 1，45..74 = 2，>=75 = 3
 *
 * 返回给外部的数值：mood/energy/affection 保留 1 位小数，manner 的归一化量保留 2 位。
 */

const MOOD_TAU = 2 * 3600 * 1000; // 心情回基线的时间常数：2 小时
const ENERGY_TAU = 3 * 3600 * 1000; // 精力回基线的时间常数：3 小时
const EMOTION_TAU = 30 * 1000; // 情绪衰减的时间常数：30 秒
const MOOD_ABSORB = 0.3; // 情绪衰减余量并入心情的系数
const AFFECTION_EMA = 0.05; // 好感 EMA 系数
const AFFECTION_PULL = 5; // Δaffection → EMA 目标的折算倍数（Δ=+20 时目标 +100）
const AXIS_MAX = 20; // apply 单轮单轴上限
const DEFAULT_AFFECTION = 20; // 与建表默认值一致

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== null ? n : fallback;
}

/** 心情基线由好感推动：好感 50 → 50，好感 100 → 60，好感 0 → 40 */
function baselineOf(affection) {
  return 50 + 0.2 * (affection - 50);
}

/** 关系阶段由好感分档 */
function stageOf(affection) {
  return affection < 20 ? 0 : affection < 45 ? 1 : affection < 75 ? 2 : 3;
}

function parseEmotion(raw) {
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      label: typeof o?.label === 'string' ? o.label : '',
      intensity: clamp(num(o?.intensity), 0, 100),
    };
  } catch {
    return { label: '', intensity: 0 };
  }
}

export function createAffect(db) {
  const SQL = {
    sel: 'SELECT mood, energy, affection, emotion, stage, updated_at FROM persons WHERE contact_id = ?',
    ins: `INSERT OR IGNORE INTO persons
            (contact_id, mood, energy, affection, emotion, stage, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    upd: `UPDATE persons
            SET mood = ?, energy = ?, affection = ?, emotion = ?, stage = ?, updated_at = ?
          WHERE contact_id = ?`,
  };
  const cache = {};
  const st = (k) => (cache[k] ??= db.prepare(SQL[k]));

  /** 只读原始行（缺行则补默认行） */
  function rowOf(contactId) {
    const id = String(contactId);
    st('ins').run(
      id,
      50,
      50,
      DEFAULT_AFFECTION,
      JSON.stringify({ label: '', intensity: 0 }),
      stageOf(DEFAULT_AFFECTION),
      Date.now(),
    );
    const row = st('sel').get(id);
    if (!row) {
      return {
        mood: 50,
        energy: 50,
        affection: DEFAULT_AFFECTION,
        emotion: { label: '', intensity: 0 },
        updatedAt: Date.now(),
      };
    }
    return {
      mood: clamp(num(row.mood, 50), 0, 100),
      energy: clamp(num(row.energy, 50), 0, 100),
      affection: clamp(num(row.affection, DEFAULT_AFFECTION), 0, 100),
      emotion: parseEmotion(row.emotion),
      updatedAt: num(row.updated_at, 0),
    };
  }

  function snapshot(s) {
    return {
      mood: round1(s.mood),
      energy: round1(s.energy),
      affection: round1(s.affection),
      stage: stageOf(s.affection),
      emotion: { label: s.emotion.label, intensity: round1(s.emotion.intensity) },
      updatedAt: s.updatedAt,
    };
  }

  function persist(contactId, s) {
    st('upd').run(
      round2(s.mood),
      round2(s.energy),
      round2(s.affection),
      JSON.stringify({ label: s.emotion.label, intensity: round2(s.emotion.intensity) }),
      stageOf(s.affection),
      s.updatedAt,
      String(contactId),
    );
  }

  /** 纯计算：把状态推进到 at（不落库） */
  function settle(s, at) {
    const dt = at - s.updatedAt;
    if (!(dt > 0)) return { ...s, emotion: { ...s.emotion } };

    let mood = s.mood;
    const emotion = { ...s.emotion };
    if (emotion.intensity > 0) {
      const left = emotion.intensity * Math.exp(-dt / EMOTION_TAU);
      mood += MOOD_ABSORB * (emotion.intensity - left); // 衰减掉的强度并入心情
      emotion.intensity = left < 0.5 ? 0 : left;
      if (emotion.intensity === 0) emotion.label = '';
    }
    const baseline = baselineOf(s.affection);
    mood += (baseline - mood) * (1 - Math.exp(-dt / MOOD_TAU));
    const energy = s.energy + (50 - s.energy) * (1 - Math.exp(-dt / ENERGY_TAU));

    return {
      mood: clamp(mood, 0, 100),
      energy: clamp(energy, 0, 100),
      affection: s.affection,
      emotion,
      updatedAt: at,
    };
  }

  function ensure(contactId) {
    rowOf(contactId);
    return get(contactId);
  }

  function get(contactId) {
    return snapshot(rowOf(contactId));
  }

  /** 衰减到 at（缺省 now）：心情回基线，情绪 30s 指数衰减 */
  function tick(contactId, at) {
    const t = num(at, Date.now());
    const row = rowOf(contactId);
    const state = settle(row, t);
    state.updatedAt = Math.max(t, row.updatedAt);
    persist(contactId, state);
    return snapshot(state);
  }

  /** 外部事件注入：{mood?, energy?, affection?}，每轴 ±20/轮，0..100 */
  function apply(contactId, deltas, reason) {
    void reason; // 暂不入库：留作将来审计/归因
    const d = deltas && typeof deltas === 'object' ? deltas : {};
    const at = Date.now();
    const row = rowOf(contactId);
    const state = settle(row, at); // 先结清到期的衰减，避免更新 updated_at 吞掉 dt
    state.updatedAt = Math.max(at, row.updatedAt);

    const axis = (key) => clamp(num(d[key]), -AXIS_MAX, AXIS_MAX);
    state.mood = clamp(state.mood + axis('mood'), 0, 100);
    state.energy = clamp(state.energy + axis('energy'), 0, 100);

    const da = axis('affection');
    if (da !== 0) {
      const target = clamp(state.affection + da * AFFECTION_PULL, 0, 100);
      state.affection = clamp(state.affection + AFFECTION_EMA * (target - state.affection), 0, 100);
    }

    persist(contactId, state);
    return snapshot(state);
  }

  /** 打一个情绪标签 + 强度（0..100）；旧情绪的余量先按当前时刻结清 */
  function setEmotion(contactId, label, intensity) {
    const at = Date.now();
    const row = rowOf(contactId);
    const state = settle(row, at);
    state.updatedAt = Math.max(at, row.updatedAt);
    state.emotion = {
      label: String(label ?? '').slice(0, 16),
      intensity: clamp(num(intensity), 0, 100),
    };
    if (state.emotion.intensity <= 0) state.emotion.label = '';
    persist(contactId, state);
    return snapshot(state);
  }

  /**
   * 语气参数：register 由好感/阶段驱动（称呼、主动、正式度），
   * texture 由心情/精力驱动（句长、emoji、语气词、标点）。
   * 归一化量 0..1；sentenceLen 是建议字数 6..32。
   */
  function manner(contactId) {
    const s = get(contactId);
    const a = clamp(s.affection, 0, 100) / 100;
    const m = (clamp(s.mood, 0, 100) - 50) / 50; // 心情 -1..1
    const e = (clamp(s.energy, 0, 100) - 50) / 50; // 精力 -1..1
    return {
      register: {
        closeness: round2(clamp(0.15 + 0.7 * a + 0.05 * s.stage, 0, 1)),
        initiative: round2(clamp(0.45 + 0.35 * e + 0.2 * m, 0, 1)),
        formality: round2(clamp(0.7 - 0.5 * a, 0.1, 0.8)),
      },
      texture: {
        sentenceLen: Math.round(clamp(14 + 9 * m + 4 * e + 6 * a, 6, 32)),
        emoji: round2(clamp(0.1 + 0.4 * m + 0.1 * e + 0.2 * a, 0, 0.9)),
        particles: round2(clamp(0.2 + 0.3 * m + 0.1 * e, 0, 0.8)),
        punctuation: round2(clamp(0.35 + 0.25 * m + 0.1 * a, 0.1, 0.85)),
      },
    };
  }

  /** 中文一句（≤60 字），给 prompt 用 */
  function describe(contactId) {
    const s = get(contactId);
    const moodWord =
      s.mood >= 75 ? '挺松快' : s.mood >= 60 ? '偏松快' : s.mood >= 45 ? '还算平稳' : s.mood >= 30 ? '有点闷' : '挺低落';
    const energyWord =
      s.energy >= 70 ? '精神挺足' : s.energy >= 45 ? '还算有劲' : s.energy >= 30 ? '有点累' : '快没电了';
    const relWord =
      s.affection >= 75 ? '很依赖你' : s.affection >= 45 ? '对你挺亲近' : s.affection >= 20 ? '跟你有点熟了' : '还很客气';

    let out = `心情 ${Math.round(s.mood)} ${moodWord}，精力 ${Math.round(s.energy)} ${energyWord}，${relWord}`;
    if (s.emotion.label && s.emotion.intensity >= 25) out += `，此刻${s.emotion.label}`;
    return out.length > 60 ? `${out.slice(0, 59)}…` : out;
  }

  return { ensure, tick, get, apply, setEmotion, manner, describe };
}
