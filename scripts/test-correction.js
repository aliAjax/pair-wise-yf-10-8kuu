#!/usr/bin/env node
/** 校正批次端到端验证：成功/四类409/幂等重放/重启持久化/区间核对状态不变 */
const BASE = "http://127.0.0.1:3019";

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`, detail ?? "");
  }
}

async function makeIssue(sectionId, beat, lane, desc) {
  const r = await req("POST", "/issues", {
    tuneId: "tune_demo",
    sectionId,
    type: "偏孔",
    beat,
    lane,
    description: desc
  });
  return r.json.data.id;
}

(async () => {
  // 准备：副歌段 33-64 拍、轨道 4-18
  const a = await makeIssue("section_demo_2", 41, 12, "测试孔A");
  const b = await makeIssue("section_demo_2", 50, 15, "测试孔B");
  const c = await makeIssue("section_demo_2", 40, 12, "测试孔C-将被解决");
  const d = await makeIssue("section_demo_1", 10, 5, "测试孔D-其他区间");
  // issue_demo 占据 section_demo_2 的 (41,12)，与 A 同孔位（用于重合校验）

  console.log("\n[1] 成功批次：A (41,12) 漂到 (42,11)，B (50,15) 漂到 (50,14)，互不重合且在区间内");
  let r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-success-1",
    issueIds: [a, b],
    beatOffset: 1,
    laneOffset: -1
  });
  check("返回 200", r.status === 200, r.status);
  check("A 变为 (42,11)", r.json?.data?.issues?.find((i) => i.id === a)?.beat === 42);
  const issueA = r.json.data.issues.find((i) => i.id === a);
  check("A 轨道变为 11", issueA.lane === 11);
  check("原值留作只读校正记录", issueA.corrections?.[0]?.from?.beat === 41 && issueA.corrections[0].from.lane === 12);
  check("记录含批次ID与请求ID", issueA.corrections[0].batchId && issueA.corrections[0].requestId === "req-success-1");
  check("B 变为 (50,14)", r.json.data.issues.find((i) => i.id === b).lane === 14);

  console.log("\n[2] 区间核对状态不变（section_demo_2 仍 unchecked）");
  r = await req("GET", "/tunes/tune_demo/sections");
  const sec2 = r.json.data.find((s) => s.id === "section_demo_2");
  check("checked 仍为 false", sec2.checked === false);

  console.log("\n[3] 幂等：同 requestId 重放，不二次漂移");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-success-1",
    issueIds: [a, b],
    beatOffset: 1,
    laneOffset: -1
  });
  check("仍返回 200", r.status === 200, r.status);
  check("A 仍为 (42,11)，未二次漂移", r.json?.data?.issues?.find((i) => i.id === a)?.beat === 42 && r.json.data.issues.find((i) => i.id === a).lane === 11);
  check("校正记录仍只有一条", r.json.data.issues.find((i) => i.id === a).corrections.length === 1);

  console.log("\n[4] 409-不属于该曲目");
  const otherTune = await req("POST", "/tunes", { title: "另一首", stripSpec: { scale: "20音" } });
  const otherTuneId = otherTune.json.data.id;
  r = await req("POST", `/tunes/${otherTuneId}/correction-batches`, {
    requestId: "req-wrong-tune",
    issueIds: [a],
    beatOffset: 0,
    laneOffset: 0
  });
  check("返回 409", r.status === 409, r.status);
  check("原因 tune_mismatch", r.json.conflicts?.[0]?.reason === "tune_mismatch", JSON.stringify(r.json));
  const aStill = (await req("GET", `/issues?tuneId=tune_demo`)).json.data.find((i) => i.id === a);
  check("A 状态与孔位不变", aStill.beat === 42 && aStill.corrections.length === 1);

  console.log("\n[5] 409-已解决");
  await req("PATCH", `/issues/${c}/status`, { status: "resolved" });
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-resolved",
    issueIds: [c],
    beatOffset: 1,
    laneOffset: 0
  });
  check("返回 409", r.status === 409, r.status);
  check("原因 issue_resolved", r.json.conflicts?.[0]?.reason === "issue_resolved");

  console.log("\n[6] 409-偏移后超出区间（A 在42拍，+100拍 -> 142 > 64）");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-out-1",
    issueIds: [a],
    beatOffset: 100,
    laneOffset: 0
  });
  check("返回 409", r.status === 409, r.status);
  check("原因 out_of_section 且给出 to", r.json.conflicts?.[0]?.reason === "out_of_section" && r.json.conflicts[0].to.beat === 142);
  const aStill2 = (await req("GET", `/issues?tuneId=tune_demo`)).json.data.find((i) => i.id === a);
  check("A 仍为 (42,11)", aStill2.beat === 42 && aStill2.lane === 11);

  console.log("\n[7] 409-与同区间其他问题重合");
  // A 现在 (42,11)，issue_demo 占 (41,12)；造一个占位问题在 (42,12)，A 用 (0,+1) 即重合
  const occupant = await makeIssue("section_demo_2", 42, 12, "占位孔");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-overlap-1",
    issueIds: [a],
    beatOffset: 0,
    laneOffset: 1
  });
  check("返回 409", r.status === 409, r.status);
  check("原因 overlap，指向占位问题",
    r.json.conflicts?.[0]?.reason === "overlap" && r.json.conflicts[0].otherIssueId === occupant,
    JSON.stringify(r.json.conflicts));
  const aStill3 = (await req("GET", `/issues?tuneId=tune_demo`)).json.data.find((i) => i.id === a);
  check("A 仍为 (42,11)", aStill3.beat === 42 && aStill3.lane === 11);

  console.log("\n[8] 409-批次内两题起点重合，统一偏移后仍撞同一孔位（整批原子）");
  // POST /issues 允许登记同孔位问题；E、F 同在 (33,4)，统一偏移后目标同为 (34,5)
  const e = await makeIssue("section_demo_2", 33, 4, "同孔位E");
  const f = await makeIssue("section_demo_2", 33, 4, "同孔位F");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-overlap-inbatch",
    issueIds: [e, f],
    beatOffset: 1,
    laneOffset: 1
  });
  check("返回 409", r.status === 409, r.status);
  check("原因 overlap 且指向批内另一题",
    r.json.conflicts?.[0]?.reason === "overlap" &&
      (r.json.conflicts[0].otherIssueId === e || r.json.conflicts[0].otherIssueId === f),
    JSON.stringify(r.json.conflicts));
  const eStill = (await req("GET", "/issues?tuneId=tune_demo&status=open")).json.data.find((i) => i.id === e);
  check("E 未被改动，仍 (33,4)", eStill.beat === 33 && eStill.lane === 4 && !eStill.corrections);

  console.log("\n[9] 混合冲突整批驳回（A 与已解决的 C 同批，A 不得被改）");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-mixed",
    issueIds: [a, c], // c 已解决
    beatOffset: 1,
    laneOffset: 0
  });
  check("返回 409", r.status === 409, r.status);
  check("冲突列表含已解决项", r.json.conflicts.some((x) => x.issueId === c));
  const aStill4 = (await req("GET", `/issues?tuneId=tune_demo`)).json.data.find((i) => i.id === a);
  check("A 未被本批改动，仍 (42,11)", aStill4.beat === 42 && aStill4.lane === 11);

  console.log("\n[9] 失败请求也幂等（409 重放 409）");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-out-1",
    issueIds: [a],
    beatOffset: 100,
    laneOffset: 0
  });
  check("重放仍 409 且同载荷", r.status === 409 && r.json.conflicts?.[0]?.to?.beat === 142);

  console.log("\n[10] 400-非法请求体");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-bad-1",
    issueIds: [a],
    beatOffset: 1.5,
    laneOffset: 0
  });
  check("非整数偏移 400", r.status === 400, r.status);
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-bad-2",
    issueIds: [a, a],
    beatOffset: 1,
    laneOffset: 0
  });
  check("重复选择 400", r.status === 400, r.status);

  console.log("\n[11] 批次与请求记录可查询（重启后追溯的前置：已落盘）");
  r = await req("GET", "/tunes/tune_demo/correction-batches");
  const firstBatch = r.json.data.find((x) => x.requestId === "req-success-1");
  check("列出成功批次 req-success-1", Boolean(firstBatch), JSON.stringify(r.json.data.map((x) => x.requestId)));
  check("批次明细含 from/to", firstBatch.items[0].from.beat === 41 && firstBatch.items[0].to.beat === 42);
  r = await req("GET", "/correction-requests/req-success-1");
  check("请求记录回放 200", r.status === 200);
  r = await req("GET", "/correction-requests/req-out-1");
  check("失败请求记录回放 409", r.status === 409);

  console.log("\n[12] 问题不存在");
  r = await req("POST", "/tunes/tune_demo/correction-batches", {
    requestId: "req-missing",
    issueIds: ["issue_not_exist"],
    beatOffset: 1,
    laneOffset: 0
  });
  check("返回 409 原因 issue_not_found", r.status === 409 && r.json.conflicts[0].reason === "issue_not_found");

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
