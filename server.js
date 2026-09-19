const http = require("http");
const { makeId, readDb, writeDb } = require("./lib/db-store");
const correction = require("./lib/correction-service");

const PORT = Number(process.env.PORT || 3019);

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/correction-batches",
  "POST /tunes/:id/correction-batches",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /correction-requests/:requestId"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

function validateBatchBody(body) {
  required(body, ["requestId", "issueIds", "beatOffset", "laneOffset"]);
  if (typeof body.requestId !== "string" || !body.requestId.trim()) {
    const error = new Error("requestId 必须是非空字符串");
    error.status = 400;
    throw error;
  }
  if (!Array.isArray(body.issueIds) || !body.issueIds.length) {
    const error = new Error("issueIds 必须是非空数组");
    error.status = 400;
    throw error;
  }
  if (body.issueIds.some((id) => typeof id !== "string")) {
    const error = new Error("issueIds 中的元素必须是问题ID字符串");
    error.status = 400;
    throw error;
  }
  if (new Set(body.issueIds).size !== body.issueIds.length) {
    const error = new Error("同一问题不能在校正批次中重复选择");
    error.status = 400;
    throw error;
  }
  const beatOffset = Number(body.beatOffset);
  const laneOffset = Number(body.laneOffset);
  if (!Number.isInteger(beatOffset) || !Number.isInteger(laneOffset)) {
    const error = new Error("拍号偏移和轨道偏移必须为整数");
    error.status = 400;
    throw error;
  }
  return {
    requestId: body.requestId.trim(),
    issueIds: body.issueIds,
    beatOffset,
    laneOffset
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const correctionBatchesMatch = pathname.match(/^\/tunes\/([^/]+)\/correction-batches$/);
  if (correctionBatchesMatch && req.method === "GET") {
    const tuneId = correctionBatchesMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: correction.listBatches(db, tuneId) });
  }

  if (correctionBatchesMatch && req.method === "POST") {
    const tuneId = correctionBatchesMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);

    // 幂等优先：requestId 已出现过就原样重放首次结果（成功或 409），
    // 即使本次请求体不合法也不影响首次结论；记录已落盘，重启后仍可追溯
    if (typeof body.requestId === "string" && body.requestId.trim()) {
      const previous = correction.findRequest(db, body.requestId.trim());
      if (previous) return send(res, previous.status, previous.body);
    }

    const payload = validateBatchBody(body);

    const plan = correction.planBatch(db, tuneId, payload.issueIds, payload.beatOffset, payload.laneOffset);
    if (!plan.ok) {
      const errorBody = {
        error: "校正批次存在冲突，整批未执行",
        conflicts: plan.conflicts
      };
      correction.recordRequest(db, payload, 409, errorBody);
      await writeDb(db);
      return send(res, 409, errorBody);
    }

    const batch = correction.applyBatch(db, { ...payload, tuneId, moves: plan.moves });
    const data = {
      batch,
      issues: plan.moves.map((move) =>
        db.issues.find((item) => item.id === move.issue.id)
      )
    };
    correction.recordRequest(db, payload, 200, { data });
    await writeDb(db);
    return send(res, 200, { data });
  }

  const correctionRequestMatch = pathname.match(/^\/correction-requests\/([^/]+)$/);
  if (correctionRequestMatch && req.method === "GET") {
    const record = correction.findRequest(db, decodeURIComponent(correctionRequestMatch[1]));
    if (!record) return send(res, 404, { error: "校正请求不存在" });
    return send(res, record.status, record.body);
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
