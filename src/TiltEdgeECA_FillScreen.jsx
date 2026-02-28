import React, { useEffect, useMemo, useRef, useState } from "react";

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function makeRuleLUT(rule) {
  return new Array(8).fill(0).map((_, i) => (rule >> i) & 1);
}

// Fixed boundary (no wrap): out-of-bounds treated as 0
function stepECA(prev, lut) {
  const n = prev.length;
  const next = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const left = i === 0 ? 0 : prev[i - 1];
    const mid = prev[i];
    const right = i === n - 1 ? 0 : prev[i + 1];
    const idx = (left << 2) | (mid << 1) | right;
    next[i] = lut[idx];
  }
  return next;
}

function dominantEdgeFromTilt(beta, gamma, deadzone = 6) {
  const ab = Math.abs(beta);
  const ag = Math.abs(gamma);
  if (ab < deadzone && ag < deadzone) return null;
  if (ag >= ab) return gamma >= 0 ? "right" : "left";
  return beta >= 0 ? "top" : "bottom";
}

function mapToScreen(edge, t, x, W, H) {
  switch (edge) {
    case "bottom":
      return { sx: x, sy: t };
    case "top":
      return { sx: x, sy: H - 1 - t };
    case "left":
      return { sx: t, sy: x };
    case "right":
      return { sx: H - 1 - t, sy: x };
    default:
      return { sx: x, sy: t };
  }
}

export default function TiltEdgeECA_FillScreen() {
  // CA size in cells
  const W = 400;
  const H = 260;

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  const [rule, setRule] = useState(110);
  const lut = useMemo(() => makeRuleLUT(rule), [rule]);

  const [running, setRunning] = useState(true);

  // Fill mode: "fit" keeps aspect ratio, "stretch" fills both axes
  const [fillMode, setFillMode] = useState("fit");

  // Zoom multiplier
  const [zoom, setZoom] = useState(1);

  // Motion
  const [motionOn, setMotionOn] = useState(false);
  const [sensorStatus, setSensorStatus] = useState("motion disabled");
  const tiltRef = useRef({ beta: 0, gamma: 0, edge: null });
  const lastSensorTsRef = useRef(0);

  // Manual edge override
  const [manualEdge, setManualEdge] = useState(null);
  const [activeEdge, setActiveEdge] = useState("bottom");

  // Ring buffer
  const gridRef = useRef({
    rows: Array.from({ length: H }, () => new Uint8Array(W)),
    head: 0,
    current: new Uint8Array(W),
  });

  // Persistent offscreen canvas + ImageData (1px per cell)
  const offRef = useRef({
    canvas: null,
    ctx: null,
    gw: 0,
    gh: 0,
    imageData: null,
  });

  function resetSimulation({ random = false } = {}) {
    const init = new Uint8Array(W);
    if (!random) {
      init[Math.floor(W / 2)] = 1;
    } else {
      for (let i = 0; i < W; i++) init[i] = Math.random() > 0.5 ? 1 : 0;
    }

    const rows = Array.from({ length: H }, () => new Uint8Array(W));
    rows[0].set(init);
    gridRef.current = { rows, head: 0, current: init };
  }

  // Resize canvas to container (crucial for avoiding “0x0 black screen”)
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  function ensureOffscreen(edge) {
    const gw = edge === "left" || edge === "right" ? H : W;
    const gh = edge === "left" || edge === "right" ? W : H;

    const o = offRef.current;
    if (!o.canvas) {
      o.canvas = document.createElement("canvas");
      o.ctx = o.canvas.getContext("2d", { willReadFrequently: true });
    }

    if (o.gw !== gw || o.gh !== gh || !o.imageData) {
      o.gw = gw;
      o.gh = gh;
      o.canvas.width = gw;
      o.canvas.height = gh;
      o.imageData = o.ctx.createImageData(gw, gh);
    }

    return o;
  }

  async function enableMotion() {
    try {
      // Some browsers expose this (not usually Android Chrome, but safe)
      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== "granted") {
          setSensorStatus("permission denied");
          setMotionOn(false);
          return;
        }
      }

      setMotionOn(true);
      setSensorStatus("listening… tilt the tablet");
    } catch {
      setMotionOn(true);
      setSensorStatus("listening…");
    }
  }

  // Sensor listeners: orientation + motion (some devices only provide one reliably)
  useEffect(() => {
    function updateFrom(beta, gamma) {
      const edge = dominantEdgeFromTilt(beta, gamma);
      tiltRef.current = { beta, gamma, edge };
      lastSensorTsRef.current = Date.now();
      setSensorStatus(
        `beta ${beta.toFixed(1)}°  gamma ${gamma.toFixed(1)}°  -> ${edge ?? "none"}`,
      );
    }

    function onOri(e) {
      if (!motionOn) return;
      const beta = typeof e.beta === "number" ? e.beta : 0;
      const gamma = typeof e.gamma === "number" ? e.gamma : 0;
      updateFrom(beta, gamma);
    }

    function onMotion(e) {
      if (!motionOn) return;
      // devicemotion gives acceleration/rotation; we can approximate “tilt” from gravity-ish acceleration
      // If accelerationIncludingGravity is present, it’s often the most usable.
      const a = e.accelerationIncludingGravity;
      if (!a) return;

      // Convert to a rough beta/gamma proxy (not perfect, but enough to detect left/right/up/down tilt)
      // x: left/right, y: up/down, z: towards sky
      const x = typeof a.x === "number" ? a.x : 0;
      const y = typeof a.y === "number" ? a.y : 0;
      const z = typeof a.z === "number" ? a.z : 0;

      // Simple mapping into degrees-ish range
      const gamma = clamp(x * 9, -90, 90);
      const beta = clamp(y * 9, -90, 90);

      // If z is near 0, device may be flat/weird; still OK
      updateFrom(beta, gamma);
    }

    window.addEventListener("deviceorientation", onOri, true);
    window.addEventListener("deviceorientationabsolute", onOri, true);
    window.addEventListener("devicemotion", onMotion, true);

    return () => {
      window.removeEventListener("deviceorientation", onOri, true);
      window.removeEventListener("deviceorientationabsolute", onOri, true);
      window.removeEventListener("devicemotion", onMotion, true);
    };
  }, [motionOn]);

  useEffect(() => {
    resetSimulation({ random: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    resetSimulation({ random: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule]);

  useEffect(() => {
    if (manualEdge && manualEdge !== activeEdge) {
      setActiveEdge(manualEdge);
      resetSimulation({ random: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualEdge]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = false;

    let lastT = performance.now();
    let stepAccumulator = 0;

    function tick(now) {
      const dt = (now - lastT) / 1000;
      lastT = now;

      // If canvas is 0x0 for any reason, avoid drawing (prevents black “stuck” states)
      if (canvas.width < 2 || canvas.height < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const desiredEdge =
        manualEdge ?? (motionOn ? tiltRef.current.edge : null) ?? activeEdge;

      if (desiredEdge && desiredEdge !== activeEdge) {
        setActiveEdge(desiredEdge);
        resetSimulation({ random: false });
      }

      const edge = desiredEdge || activeEdge;

      // Step sim
      const stepsPerSec = 70;
      stepAccumulator += dt * stepsPerSec;

      if (running) {
        while (stepAccumulator >= 1) {
          stepAccumulator -= 1;
          const g = gridRef.current;
          const next = stepECA(g.current, lut);
          g.current = next;
          g.head = (g.head + 1) % H;
          g.rows[g.head].set(next);
        }
      } else {
        stepAccumulator = Math.min(stepAccumulator, 2);
      }

      // Offscreen draw (1px per cell)
      const off = ensureOffscreen(edge);
      const { gw, gh, imageData } = off;
      const data = imageData.data;

      // White background
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }

      // Black cells
      const g = gridRef.current;
      for (let t = 0; t < H; t++) {
        const bufIdx = (g.head - (H - 1 - t) + H) % H;
        const row = g.rows[bufIdx];
        for (let x = 0; x < W; x++) {
          if (row[x] !== 1) continue;
          const { sx, sy } = mapToScreen(edge, t, x, W, H);
          if (sx < 0 || sx >= gw || sy < 0 || sy >= gh) continue;
          const p = (sy * gw + sx) * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
          data[p + 3] = 255;
        }
      }

      // Paint scaled to main canvas
      off.ctx.putImageData(imageData, 0, 0);

      const cw = canvas.width;
      const ch = canvas.height;

      let sxScale = (cw / gw) * zoom;
      let syScale = (ch / gh) * zoom;

      if (fillMode === "fit") {
        const s = Math.min(sxScale, syScale);
        sxScale = s;
        syScale = s;
      }

      const drawW = gw * sxScale;
      const drawH = gh * syScale;
      const dx = Math.floor((cw - drawW) / 2);
      const dy = Math.floor((ch - drawH) / 2);

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off.canvas, 0, 0, gw, gh, dx, dy, drawW, drawH);

      // Debug HUD (also helps confirm sensors alive)
      ctx.fillStyle = "#000";
      ctx.font = `${Math.max(12, Math.floor(12 * (window.devicePixelRatio || 1)))}px sans-serif`;
      const tr = tiltRef.current;
      const age = motionOn
        ? `${Math.max(0, Date.now() - lastSensorTsRef.current)}ms`
        : "n/a";
      ctx.fillText(
        `Rule ${rule} | Edge ${edge} | motion ${motionOn ? "ON" : "OFF"} | beta ${tr.beta.toFixed(
          1,
        )} gamma ${tr.gamma.toFixed(1)} | last sensor ${age}`,
        12,
        18,
      );

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeEdge, fillMode, H, lut, manualEdge, motionOn, rule, running, zoom]);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 12 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <label>
          Rule:&nbsp;
          <input
            type="number"
            min={0}
            max={255}
            value={rule}
            onChange={(e) =>
              setRule(clamp(parseInt(e.target.value || "0", 10), 0, 255))
            }
            style={{ width: 90 }}
          />
        </label>

        <button onClick={() => setRunning((v) => !v)}>
          {running ? "Pause" : "Play"}
        </button>
        <button onClick={() => resetSimulation({ random: false })}>
          Reset
        </button>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Fill:&nbsp;
          <select
            value={fillMode}
            onChange={(e) => setFillMode(e.target.value)}
          >
            <option value="fit">fit</option>
            <option value="stretch">stretch</option>
          </select>
        </label>

        <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          Zoom:&nbsp;
          <input
            type="range"
            min={0.25}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
          />
          <span style={{ width: 60 }}>{zoom.toFixed(2)}x</span>
        </label>

        <button onClick={enableMotion} style={{ fontWeight: 700 }}>
          Enable Motion
        </button>
        <span style={{ opacity: 0.8 }}>{sensorStatus}</span>
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <span style={{ opacity: 0.8 }}>Manual edge:</span>
        <button
          onClick={() => setManualEdge(null)}
          style={{ fontWeight: manualEdge === null ? 700 : 400 }}
        >
          Auto
        </button>
        {["left", "right", "top", "bottom"].map((e) => (
          <button
            key={e}
            onClick={() => setManualEdge(e)}
            style={{ fontWeight: manualEdge === e ? 700 : 400 }}
          >
            {e}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        style={{
          marginTop: 12,
          border: "1px solid #ddd",
          width: "100%",
          height: "70vh",
          background: "#fff",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
    </div>
  );
}
