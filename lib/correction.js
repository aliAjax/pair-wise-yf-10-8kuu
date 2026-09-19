// 孔位漂移校正业务规则：纯函数 + 一个会修改内存数据的 apply。
// 本模块只负责规则，不直接接触文件系统；数据落盘由 lib/db.js 负责。

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
    this.status = 400;
  }
}

class ConflictError extends Error {
  // status 固定 409：整批拒绝，调用方不得写入任何问题/批次
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.status = 409;
    this.details = details || [];
  }
}

function parseLaneRange(laneRange) {
  // 同时接受 "4-18"（区间）与 "1,3,5"（离散轨道）两种写法
  if (typeof laneRange !== "string") return null;
  const rangeMatch = laneRange.match(/^\s*(\d+)\s*[-~至]\s*(\d+)\s*$/);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  const lanes = laneRange
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number);
  if (lanes.length && lanes.every((lane) => Number.isInteger(lane))) {
    return { values: new Set(lanes) };
  }
  return null;
}

function laneWithinRange(lane, range) {
  if (!range) return false;
  if (range.values) return range.values.has(lane);
  return lane >= range.min && lane <= range.max;
}

function assertInteger(value, field) {
  if (!Number.isInteger(value)) {
    throw new BadRequestError(`${field} 必须是整数（拍号/轨道按格计）`);
  }
}

function planCorrection(db, { tuneId, issueIds, beatOffset, laneOffset }) {
  const seen = new Set();
  for (const issueId of issueIds) {
    if (seen.has(issueId)) {
      throw new BadRequestError(`问题重复出现在批次中：${issueId}`);
    }
    seen.add(issueId);
  }

  const conflictDetails = [];
  const targets = [];

  for (const issueId of issueIds) {
    const issue = db.issues.find((item) => item.id === issueId);
    if (!issue || issue.tuneId !== tuneId) {
      conflictDetails.push({ issueId, reason: "issue_not_in_tune" });
      continue;
    }
    if (issue.status === "resolved") {
      conflictDetails.push({ issueId, reason: "issue_resolved" });
      continue;
    }
    if (!Number.isInteger(issue.beat) || !Number.isInteger(issue.lane)) {
      // 缺少孔位坐标的问题无法参与漂移校正，属于请求本身不合法
      throw new BadRequestError(`问题 ${issueId} 缺少拍号或轨道，无法校正`);
    }

    const section = db.sections.find((item) => item.id === issue.sectionId);
    const beat = issue.beat + beatOffset;
    const lane = issue.lane + laneOffset;

    const inSection =
      section &&
      section.tuneId === tuneId &&
      beat >= section.startBeat &&
      beat <= section.endBeat &&
      laneWithinRange(lane, parseLaneRange(section.laneRange));
    if (!inSection) {
      conflictDetails.push({
        issueId,
        reason: "out_of_section",
        sectionId: issue.sectionId,
        from: { beat: issue.beat, lane: issue.lane },
        to: { beat, lane }
      });
      targets.push({ issue, section, beat, lane, out: true });
      continue;
    }
    targets.push({ issue, section, beat, lane, out: false });
  }

  if (conflictDetails.length) {
    throw new ConflictError("校正批次存在冲突，整批未执行", conflictDetails);
  }

  // 重合判定：同区间（同 sectionId）内，(beat, lane) 相同即视为孔位重合。
  // 对照对象包括区间内其他所有问题（含已解决的历史记录），以及批内互相之间。
  const occupied = new Map();
  for (const other of db.issues) {
    if (seen.has(other.id)) continue;
    if (other.tuneId !== tuneId) continue;
    if (!Number.isInteger(other.beat) || !Number.isInteger(other.lane)) continue;
    occupied.set(`${other.sectionId}:${other.beat}:${other.lane}`, other.id);
  }

  const batchPositions = new Map();
  for (const { issue, beat, lane } of targets) {
    const key = `${issue.sectionId}:${beat}:${lane}`;

    const occupant = occupied.get(key);
    if (occupant) {
      conflictDetails.push({
        issueId: issue.id,
        reason: "overlap",
        sectionId: issue.sectionId,
        to: { beat, lane },
        conflictsWith: occupant
      });
    }

    const mate = batchPositions.get(key);
    if (mate) {
      conflictDetails.push({
        issueId: issue.id,
        reason: "overlap",
        sectionId: issue.sectionId,
        to: { beat, lane },
        conflictsWith: mate
      });
    }
    batchPositions.set(key, issue.id);
  }

  if (conflictDetails.length) {
    throw new ConflictError("校正后孔位与同区间其他问题重合，整批未执行", conflictDetails);
  }

  return targets.map(({ issue, beat, lane }) => ({ issue, beat, lane }));
}

function applyCorrection(db, { requestId, tuneId, issueIds, beatOffset, laneOffset }) {
  const planned = planCorrection(db, { tuneId, issueIds, beatOffset, laneOffset });
  const now = new Date().toISOString();
  const batchId = makeId("correction");

  const items = planned.map(({ issue, beat, lane }) => {
    const before = { beat: issue.beat, lane: issue.lane };
    const record = {
      batchId,
      requestId,
      beatOffset,
      laneOffset,
      before,
      after: { beat, lane },
      sectionId: issue.sectionId,
      correctedAt: now
    };
    issue.beat = beat;
    issue.lane = lane;
    // corrections 只追加不改写，作为问题维度的只读校正记录
    issue.corrections = Array.isArray(issue.corrections) ? issue.corrections : [];
    issue.corrections.push(record);
    return { issueId: issue.id, sectionId: issue.sectionId, before, after: { beat, lane } };
  });

  // 区间核对状态（checked/note）在校正过程中完全不动
  const batch = {
    id: batchId,
    requestId,
    tuneId,
    beatOffset,
    laneOffset,
    issueIds: planned.map((entry) => entry.issue.id),
    items,
    createdAt: now
  };
  db.correctionBatches.push(batch);

  return batch;
}

module.exports = {
  makeId,
  BadRequestError,
  ConflictError,
  parseLaneRange,
  laneWithinRange,
  assertInteger,
  planCorrection,
  applyCorrection
};
