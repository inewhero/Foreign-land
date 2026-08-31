import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CirclePause, CirclePlay, Download, Globe2, MapPinned, RefreshCw, Save, Users, Wifi } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { DoseCode, ParticipantProgress, RoomSnapshot } from "../shared/types";

interface Credentials { roomCode: string; adminToken: string }
interface LocalBootstrap { roomCode: string; adminToken: string; lanAddress?: string; joinUrl?: string }

export function AdminApp() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const [credentials, setCredentials] = useState<Credentials | null>(() => {
    const roomCode = query.get("room");
    const adminToken = query.get("token");
    return roomCode && adminToken ? { roomCode, adminToken } : null;
  });
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [bootstrap, setBootstrap] = useState<LocalBootstrap>();
  const [error, setError] = useState("");
  const [qrExpanded, setQrExpanded] = useState(false);

  useEffect(() => {
    fetch("/api/local-bootstrap")
      .then((response) => {
        if (!response.ok) throw new Error("主试控制台只能从实验主机打开");
        return response.json();
      })
      .then((bootstrap) => {
        setBootstrap(bootstrap);
        if (!credentials) setCredentials({ roomCode: bootstrap.roomCode, adminToken: bootstrap.adminToken });
      })
      .catch((reason) => {
        if (!credentials) setError(reason.message);
      });
  }, []);

  useEffect(() => {
    if (!qrExpanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQrExpanded(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [qrExpanded]);

  const load = useCallback(async () => {
    if (!credentials) return;
    const response = await fetch(`/api/admin/room?roomCode=${credentials.roomCode}&adminToken=${credentials.adminToken}`);
    if (!response.ok) throw new Error("无法读取房间状态");
    setSnapshot(await response.json());
  }, [credentials]);

  useEffect(() => {
    load().catch((reason) => setError(reason.message));
    const timer = window.setInterval(() => load().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [load]);

  async function post(path: string, body: Record<string, unknown>) {
    if (!credentials) return;
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, ...body }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "操作失败");
    await load();
  }

  if (!credentials || !snapshot) {
    return <main className="admin-loading">{error || "正在连接本地 Room…"}</main>;
  }

  const participantsBySubject = snapshot.participants.reduce((groups, participant) => {
    const sessions = groups.get(participant.subjectId) ?? [];
    sessions.push(participant);
    groups.set(participant.subjectId, sessions);
    return groups;
  }, new Map<string, ParticipantProgress[]>());
  const subjectGroups = [...participantsBySubject.entries()]
    .map(([subjectId, sessions]) => ({
      subjectId,
      sessions: sessions.sort((a, b) => Number(a.waveCode.slice(1)) - Number(b.waveCode.slice(1))),
    }))
    .sort((a, b) => a.sessions[0].studyId.localeCompare(b.sessions[0].studyId));
  const connected = snapshot.participants.filter((p) => p.connected && p.status !== "complete").length;
  const completed = snapshot.participants.filter((p) => p.status === "complete").length;
  const nextBlock = Math.min(3, Math.max(0, snapshot.activeMacroBlock + 1));
  const incomplete = snapshot.participants.filter((p) => p.status !== "complete");
  const waitingForConsent = incomplete.some((p) => !p.consented);
  const canStartFirst = snapshot.activeMacroBlock < 0
    && incomplete.length >= 2
    && !waitingForConsent
    && incomplete.every((p) => Boolean(p.groupCode && p.waveCode));
  const canStartFollowing = snapshot.activeMacroBlock >= 0
    && snapshot.activeMacroBlock < 3
    && incomplete.length > 0
    && incomplete.every((p) => p.status === "rest" && p.ready && p.macroBlock === snapshot.activeMacroBlock + 1);
  const canStartNext = canStartFirst || canStartFollowing;
  const exportUrl = `/api/admin/export.csv?roomCode=${credentials.roomCode}&adminToken=${credentials.adminToken}`;
  const eventExportUrl = `/api/admin/export-events.csv?roomCode=${credentials.roomCode}&adminToken=${credentials.adminToken}`;
  const sessionExportUrl = `/api/admin/export-sessions.csv?roomCode=${credentials.roomCode}&adminToken=${credentials.adminToken}`;
  const accessSupported = typeof snapshot.joinUrl === "string" && Boolean(snapshot.joinUrl);
  const accessMode = snapshot.accessMode ?? "lan";
  const wifiName = snapshot.wifiName ?? "";
  const joinUrl = snapshot.joinUrl || bootstrap?.joinUrl || `http://${bootstrap?.lanAddress || "127.0.0.1"}:3000/?room=${snapshot.roomCode}`;

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <div className="eyebrow">异域同行 · 主试控制台</div>
          <h1>Room {snapshot.roomCode}</h1>
        </div>
        <div className={`room-status ${snapshot.status}`}>{statusLabel(snapshot.status)}</div>
      </header>

      <section className="access-card">
        <div>
          <div className="access-heading">
            <div className="eyebrow">被试入口</div>
            <span className={`access-mode-badge ${accessMode}`}>{accessMode === "lan" ? "局域网" : "公网"}</span>
          </div>
          <strong>{joinUrl}</strong>
          {accessMode === "lan" ? (
            <p>先连接 Wi‑Fi：<b>{wifiName || "尚未填写"}</b>，再扫码进入；房间码已写入链接。</p>
          ) : (
            <p>可使用移动数据或任意可联网网络扫码进入；请确保公网服务在正式实验前已完成连通测试。</p>
          )}
        </div>
        <button className="qr-trigger" type="button" onClick={() => setQrExpanded(true)} aria-label="放大被试入口二维码">
          <QRCodeSVG value={joinUrl} size={112} bgColor="#f6f0e3" fgColor="#19383a" level="M" />
          <span>点击放大</span>
        </button>
      </section>

      {accessSupported ? (
        <AccessSettings snapshot={snapshot} onSave={(settings) => post("/api/admin/access", settings)} />
      ) : (
        <section className="server-restart-note">联机方式设置将在当前实验服务安全重启后启用；现有局域网入口仍可继续使用。</section>
      )}

      {qrExpanded && (
        <div className="qr-modal" role="dialog" aria-modal="true" aria-label="被试入口二维码" onClick={() => setQrExpanded(false)}>
          <div className="qr-modal-card" onClick={(event) => event.stopPropagation()}>
            <button className="qr-close" type="button" onClick={() => setQrExpanded(false)} aria-label="关闭">×</button>
            {accessMode === "lan" && (
              <div className="wifi-guide">
                <span><Wifi /> 第一步 · 连接现场 Wi‑Fi</span>
                <strong>{wifiName || "请询问主试"}</strong>
              </div>
            )}
            <QRCodeSVG value={joinUrl} size={340} bgColor="#fffdf8" fgColor="#19383a" level="M" />
            <strong>Room {snapshot.roomCode}</strong>
            <p>{accessMode === "lan" ? "第二步 · 扫码进入异域同行" : "扫码进入异域同行"}</p>
          </div>
        </div>
      )}

      <section className="metric-grid">
        <Metric icon={<Users />} label="已连接" value={`${connected} / ${subjectGroups.length}`} />
        <Metric icon={<MapPinned />} label="当前地点" value={snapshot.activeMacroBlock < 0 ? "未开始" : `${snapshot.activeMacroBlock + 1} / 4`} />
        <Metric icon={<Activity />} label="已完成" value={String(completed)} />
      </section>

      <section className="control-bar">
        <button onClick={() => post("/api/admin/start-block", { macroBlock: nextBlock })} disabled={!canStartNext}>
          <CirclePlay /> {snapshot.activeMacroBlock < 0
            ? waitingForConsent ? "等待知情同意" : "开启第 1 站"
            : canStartNext ? `开启第 ${nextBlock + 1} 站` : "等待全员准备"}
        </button>
        <button onClick={() => post("/api/admin/pause", { paused: snapshot.status !== "paused" })}>
          {snapshot.status === "paused" ? <CirclePlay /> : <CirclePause />}
          {snapshot.status === "paused" ? "恢复" : "暂停"}
        </button>
        <button onClick={() => load()}><RefreshCw /> 刷新</button>
        <a className="admin-button" href={exportUrl}><Download /> 导出试次 CSV</a>
        <a className="admin-button" href={sessionExportUrl}><Download /> 导出纵向会话 CSV</a>
        {accessSupported && <a className="admin-button" href={eventExportUrl}><Download /> 导出过程事件 CSV</a>}
      </section>

      <section className="roster-panel">
        <div className="panel-heading">
          <div><h2>参与者进度</h2><p>实验进行中不显示选择、预测或得分。</p></div>
          <span>{subjectGroups.length} 人 · {snapshot.participants.length} 次会话</span>
        </div>
        {snapshot.participants.length === 0 ? (
          <div className="empty-roster">等待参与者使用房间码加入</div>
        ) : (
          <div className="roster-list">
            {subjectGroups.map(({ subjectId, sessions }) => (
              <SubjectSessions key={subjectId} sessions={sessions} credentials={credentials} onSaved={load} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function SubjectSessions({ sessions, credentials, onSaved }: {
  sessions: ParticipantProgress[];
  credentials: Credentials;
  onSaved: () => Promise<void>;
}) {
  const latest = sessions.at(-1)!;
  const nextWaveNumber = Number(latest.waveCode.slice(1)) + 1;
  const canOpenNext = latest.status === "complete" && latest.protocolVersion === "ctp-v2" && nextWaveNumber <= 8;
  const [opening, setOpening] = useState(false);

  async function openNextWave() {
    setOpening(true);
    try {
      const response = await fetch("/api/admin/open-next-wave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials, participantId: latest.participantId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "下一波次创建失败");
      await onSaved();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "下一波次创建失败");
    } finally {
      setOpening(false);
    }
  }

  return (
    <section className="subject-sessions">
      <header className="subject-session-heading">
        <div><strong>{latest.studyId}</strong><span>{sessions.length} 次纵向会话</span></div>
        <div className="subject-session-tags">
          <span>{latest.doseCode === "short96" ? "短版 96" : latest.doseCode === "long192" ? "长版 192" : "旧版 240"}</span>
          {latest.protocolDeviation && <span className="deviation-tag">含方案偏离</span>}
          <button type="button" disabled={!canOpenNext || opening} onClick={openNextWave}>
            {opening ? "创建中…" : canOpenNext ? `开启 T${nextWaveNumber}` : nextWaveNumber > 8 ? "已到 T8" : "完成后可续接"}
          </button>
        </div>
      </header>
      {sessions.map((participant) => (
        <ParticipantRow key={participant.participantId} participant={participant} credentials={credentials} onSaved={onSaved} />
      ))}
    </section>
  );
}

function AccessSettings({ snapshot, onSave }: {
  snapshot: RoomSnapshot;
  onSave: (settings: Record<string, unknown>) => Promise<void>;
}) {
  const [accessMode, setAccessMode] = useState(snapshot.accessMode);
  const [wifiName, setWifiName] = useState(snapshot.wifiName);
  const [publicBaseUrl, setPublicBaseUrl] = useState(snapshot.publicBaseUrl);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => setAccessMode(snapshot.accessMode), [snapshot.accessMode]);
  useEffect(() => setWifiName(snapshot.wifiName), [snapshot.wifiName]);
  useEffect(() => setPublicBaseUrl(snapshot.publicBaseUrl), [snapshot.publicBaseUrl]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      await onSave({ accessMode, wifiName, publicBaseUrl });
      setMessage("入口设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "入口设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="access-settings">
      <div className="access-settings-title">
        {accessMode === "lan" ? <Wifi /> : <Globe2 />}
        <div><h2>联机方式</h2><p>切换后二维码立即更新，不会改变房间码或已收集数据。</p></div>
      </div>
      <div className="access-settings-fields">
        <label>接入模式
          <select value={accessMode} onChange={(event) => setAccessMode(event.target.value as RoomSnapshot["accessMode"])}>
            <option value="lan">局域网</option>
            <option value="public">公网</option>
          </select>
        </label>
        {accessMode === "lan" ? (
          <>
            <label>现场 Wi‑Fi 名称
              <input value={wifiName} maxLength={80} onChange={(event) => setWifiName(event.target.value)} placeholder="例如：Expedition-Lab" />
            </label>
            <div className="access-readonly"><span>本机局域网地址</span><strong>{snapshot.lanAddress}</strong></div>
          </>
        ) : (
          <label className="public-url-field">公网入口地址
            <input type="url" value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="https://experiment.example.com" />
            <small>这里填写已经映射到本服务的地址；切换本身不会自动创建公网隧道。</small>
          </label>
        )}
        <button className="access-save" type="button" onClick={save} disabled={saving || (accessMode === "public" && !publicBaseUrl.trim())}>
          <Save /> {saving ? "保存中…" : "保存设置"}
        </button>
      </div>
      {message && <div className="access-message" role="status">{message}</div>}
    </section>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <article className="metric-card"><div>{icon}</div><span>{label}</span><strong>{value}</strong></article>;
}

function ParticipantRow({ participant, credentials, onSaved }: { participant: ParticipantProgress; credentials: Credentials; onSaved: () => Promise<void> }) {
  const [groupCode, setGroupCode] = useState(participant.groupCode || "实验");
  const [waveCode, setWaveCode] = useState(participant.waveCode || "T0");
  const [notes, setNotes] = useState(participant.notes || "");
  const [doseCode, setDoseCode] = useState<DoseCode | "legacy240">(participant.doseCode);
  const [saving, setSaving] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [targetBlock, setTargetBlock] = useState(Math.min(3, participant.macroBlock));
  const [targetCompanion, setTargetCompanion] = useState(participant.companionIndex);
  const trialsWithCompanion = participant.totalTrials / 8;
  const [targetRound, setTargetRound] = useState(Math.min(trialsWithCompanion, participant.validRound + 1));

  useEffect(() => {
    setGroupCode(participant.groupCode || "实验");
    setWaveCode(participant.waveCode || "T0");
    setNotes(participant.notes || "");
    setDoseCode(participant.doseCode);
  }, [participant.groupCode, participant.waveCode, participant.notes, participant.doseCode]);

  useEffect(() => {
    setTargetBlock(Math.min(3, participant.macroBlock));
    setTargetCompanion(participant.companionIndex);
    setTargetRound(Math.min(trialsWithCompanion, participant.validRound + 1));
  }, [participant.macroBlock, participant.companionIndex, participant.validRound, trialsWithCompanion]);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...credentials, participantId: participant.participantId, groupCode, waveCode, doseCode, notes }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "保存失败");
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function control(action: "jump" | "force_start" | "force_end" | "force_delete") {
    let confirmStudyId: string | undefined;
    if (action === "force_end" && !window.confirm(`确定强制结束 ${participant.studyId} 的全部实验吗？`)) return;
    if (action === "force_delete") {
      confirmStudyId = window.prompt(`此操作会永久删除 ${participant.studyId} 的全部波次、同意书、试次和过程记录。\n请输入研究编号确认：`) ?? undefined;
      if (!confirmStudyId) return;
    }
    setControlBusy(true);
    try {
      const response = await fetch("/api/admin/participant-control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...credentials,
          participantId: participant.participantId,
          action,
          macroBlock: targetBlock,
          companionIndex: targetCompanion,
          validRound: targetRound - 1,
          confirmStudyId,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "单人控制失败");
      await onSaved();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "单人控制失败");
    } finally {
      setControlBusy(false);
    }
  }

  const overall = participant.completedTrials;
  return (
    <article className="participant-row">
      <div className={`connection-dot ${participant.connected ? "online" : "offline"}`} title={participant.connected ? "在线" : "离线"}></div>
      <div className="participant-id"><strong>{participant.waveCode}</strong><span>{participantStatus(participant)}</span></div>
      <div className="progress-cell"><div><span style={{ width: `${participant.totalTrials ? overall / participant.totalTrials * 100 : 0}%` }}></span></div><small>{overall} / {participant.totalTrials}</small></div>
      <div className="assignment-fields">
        <select aria-label="波次" value={waveCode} onChange={(e) => setWaveCode(e.target.value)} disabled={participant.assignmentLocked}>
          {Array.from({ length: 9 }, (_, index) => <option key={index} value={`T${index}`}>T{index}</option>)}
        </select>
        <select aria-label="组别" value={groupCode} onChange={(e) => setGroupCode(e.target.value)} disabled={participant.assignmentLocked || participant.doseLocked}>
          <option value="实验">实验组</option>
          <option value="对照">对照组</option>
        </select>
        <select aria-label="测量长度" value={doseCode} onChange={(e) => setDoseCode(e.target.value as DoseCode)} disabled={participant.doseLocked || participant.assignmentLocked || participant.protocolVersion !== "ctp-v2"}>
          {doseCode === "legacy240" && <option value="legacy240">旧版 240</option>}
          <option value="short96">短版 96</option>
          <option value="long192">长版 192</option>
        </select>
        <input aria-label="备注" placeholder="备注（选填）" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button onClick={save} disabled={saving}>{saving ? "…" : participant.assignmentLocked ? "存备注" : "保存"}</button>
      </div>
      <div className="anomaly-cell">{participant.predictionTimeouts + participant.choiceTimeouts > 0 ? `超时 ${participant.predictionTimeouts + participant.choiceTimeouts}` : "正常"}</div>
      <details className="participant-controls">
        <summary>单被试控制</summary>
        <div className="control-fields">
          <label>区组
            <select value={targetBlock} onChange={(event) => setTargetBlock(Number(event.target.value))}>
              {[0, 1, 2, 3].map((block) => <option key={block} value={block}>第 {block + 1} 段</option>)}
            </select>
          </label>
          <label>同行者
            <select value={targetCompanion} onChange={(event) => setTargetCompanion(Number(event.target.value))}>
              <option value={0}>{String.fromCharCode(65 + targetBlock * 2)}</option>
              <option value={1}>{String.fromCharCode(66 + targetBlock * 2)}</option>
            </select>
          </label>
          <label>下一轮
            <select value={targetRound} onChange={(event) => setTargetRound(Number(event.target.value))}>
              {Array.from({ length: trialsWithCompanion }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
            </select>
          </label>
          <button disabled={controlBusy} onClick={() => control("jump")}>跳转</button>
          <button disabled={controlBusy || !participant.consented} onClick={() => control("force_start")}>强制开始</button>
          <button className="warning" disabled={controlBusy || participant.status === "complete"} onClick={() => control("force_end")}>强制结束</button>
          <button className="danger" disabled={controlBusy} onClick={() => control("force_delete")}>强制删除</button>
        </div>
      </details>
    </article>
  );
}

const statusLabel = (status: RoomSnapshot["status"]) => ({ lobby: "集结中", running: "进行中", paused: "已暂停", complete: "已结束" })[status];
const participantStatus = (p: ParticipantProgress) => {
  if (!p.consented) return "待签署知情同意";
  return ({
    lobby: "等待确认",
    active: `第 ${p.macroBlock + 1} 站 · 同行者 ${String.fromCharCode(65 + p.macroBlock * 2 + p.companionIndex)}`,
    rest: p.ready ? "休整完成 · 已准备" : "休整中",
    paused: "已暂停",
    complete: "已完成",
  })[p.status];
};
