const { makeId } = require("./db-store");

/**
 * 孔位漂移校正业务模块
 *
 * 只处理校正规则与批次/请求记录的增删查，不直接读写文件；
 * 持久化由调用方通过 db-store 完成，做到"规则"与"落盘"分离。
 */

function parseLaneRange(laneRange) {
  if (typeof laneRange !== "string") return null;
  const match = laneRange.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

/**
 * 校验一批开放问题施加统一偏移后的结果，不产生任何写入。
 * 冲突按问题逐条收集，冲突原因之一即整批驳回（由调用方返回 409）。
 */
function planBatch(db, tuneId, issueIds, beatOffset, laneOffset) {
  const moves = [];
  const conflicts = [];

  for (const issueId of issueIds) {
    const issue = db.issues.find((item) => item.id === issueId);
    if (!issue) {
      conflicts.push({ issueId, reason: "issue_not_found", message: "问题不存在" });
      continue;
    }
    if (issue.tuneId !== tuneId) {
      conflicts.push({ issueId, reason: "tune_mismatch", message: "问题不属于该曲目" });
      continue;
    }
    if (issue.status === "resolved") {
      conflicts.push({ issueId, reason: "issue_resolved", message: "问题已解决，不能校正" });
      continue;
    }
    if (typeof issue.beat !== "number" || typeof issue.lane !== "number") {
      conflicts.push({ issueId, reason: "position_missing", message: "问题缺少拍号或轨道，无法漂移" });
      continue;
    }

    const section = db.sections.find((item) => item.id === issue.sectionId);
    const lanes = section ? parseLaneRange(section.laneRange) : null;
    const nextBeat = issue.beat + beatOffset;
    const nextLane = issue.lane + laneOffset;

    const beatOk = section && Number.isInteger(nextBeat) && nextBeat >= section.startBeat && nextBeat <= section.endBeat;
    const laneOk = lanes && Number.isInteger(nextLane) && nextLane >= lanes.min && nextLane <= lanes.max;
    if (!beatOk || !laneOk) {
      conflicts.push({
        issueId,
        reason: "out_of_section",
        message: "偏移后超出所属区间",
        sectionId: issue.sectionId,
        from: { beat: issue.beat, lane: issue.lane },
        to: { beat: nextBeat, lane: nextLane }
      });
      continue;
    }

    moves.push({ issue, section, nextBeat, nextLane });
  }

  if (conflicts.length) return { ok: false, conflicts, moves: [] };

  // 同一批次内若两个问题漂到同一孔位，视为互相重合
  const claimed = new Map();
  for (const move of moves) {
    const key = `${move.issue.sectionId}:${move.nextBeat}:${move.nextLane}`;
    const other = claimed.get(key);
    if (other) {
      conflicts.push({
        issueId: move.issue.id,
        reason: "overlap",
        message: "与同区间其他问题的孔位重合",
        sectionId: move.issue.sectionId,
        to: { beat: move.nextBeat, lane: move.nextLane },
        otherIssueId: other.issue.id
      });
    } else {
      claimed.set(key, move);
    }
  }

  // 与区间内未参与本批的既有问题（开放或已解决）核对孔位
  const batchIds = new Set(issueIds);
  for (const move of moves) {
    if (conflicts.some((item) => item.issueId === move.issue.id)) continue;
    const occupant = db.issues.find(
      (item) =>
        !batchIds.has(item.id) &&
        item.sectionId === move.issue.sectionId &&
        typeof item.beat === "number" &&
        typeof item.lane === "number" &&
        item.beat === move.nextBeat &&
        item.lane === move.nextLane
    );
    if (occupant) {
      conflicts.push({
        issueId: move.issue.id,
        reason: "overlap",
        message: "与同区间其他问题的孔位重合",
        sectionId: move.issue.sectionId,
        to: { beat: move.nextBeat, lane: move.nextLane },
        otherIssueId: occupant.id
      });
    }
  }

  return conflicts.length ? { ok: false, conflicts, moves: [] } : { ok: true, conflicts: [], moves };
}

/**
 * 应用一个已通过校验的校正批次：原地更新问题孔位，原值追加为只读校正记录。
 * 区间的 checked/核对状态不在此处修改。
 */
function applyBatch(db, { tuneId, issueIds, beatOffset, laneOffset, requestId, moves }) {
  const now = new Date().toISOString();
  const batchId = makeId("corrbatch");
  const items = [];

  for (const move of moves) {
    const issue = move.issue;
    const record = {
      id: makeId("corrrec"),
      batchId,
      requestId,
      sectionId: issue.sectionId,
      from: { beat: issue.beat, lane: issue.lane },
      to: { beat: move.nextBeat, lane: move.nextLane },
      beatOffset,
      laneOffset,
      appliedAt: now
    };
    issue.beat = move.nextBeat;
    issue.lane = move.nextLane;
    issue.corrections ??= [];
    issue.corrections.push(record);
    items.push({ issueId: issue.id, ...record });
  }

  const batch = {
    id: batchId,
    requestId,
    tuneId,
    issueIds,
    beatOffset,
    laneOffset,
    status: "applied",
    appliedAt: now,
    items
  };
  db.correctionBatches.push(batch);
  return batch;
}

function recordRequest(db, { requestId, tuneId, issueIds, beatOffset, laneOffset }, status, body) {
  const record = {
    requestId,
    tuneId,
    issueIds,
    beatOffset,
    laneOffset,
    status,
    body,
    recordedAt: new Date().toISOString()
  };
  db.correctionRequests.push(record);
  return record;
}

function findRequest(db, requestId) {
  return db.correctionRequests.find((item) => item.requestId === requestId) || null;
}

function listBatches(db, tuneId) {
  return db.correctionBatches.filter((item) => item.tuneId === tuneId);
}

module.exports = { parseLaneRange, planBatch, applyBatch, recordRequest, findRequest, listBatches };
