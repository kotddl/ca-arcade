import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Tilt-edge ECA — Fullscreen + Tilt-speed + Zoom
 *
 * Changes vs your last version:
 * 1) Fills the whole screen: W/H are derived from the viewport + cellSize.
 * 2) Tilt controls speed: more tilt => more steps/sec.
 * 3) Zoom out/in: changes cellSize (smaller cells => more columns/rows visible).
 * 4) Rule 110 "triangle" issue: you now have seed modes.
 *    - Single seed (good for Rule 90 style structure)
 *    - Center + sprinkle noise (keeps a clear origin but activates more of the width)
 *    - Random (fully dense)
 *
 * NOTE: This does NOT wrap boundaries or auto-expand.
 * Boundaries are fixed zeros; we simply choose an initial condition that can fill the screen.
 */

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function makeRuleLUT(rule) {
  // index 0..7 corresponds to neighborhood 000..111
  return new Array(8).fill(0).map((_, i) => (rule >> i) & 1);
}

/**
 * Non-wrapping ECA step (fixed boundaries): out-of-bounds treated as 0.
 */
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

function speed01FromTilt(beta, gamma) {
  // 0..1 based on max tilt magnitude, clamped.
  const mag = Math.max(Math.abs(beta), Math.abs(gamma));
  return clamp(mag, 0, 45) / 45;
}

// Map CA coordinates (t,x) -> screen grid coords (sx,sy) depending on edge.
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

function defaultSeedModeForRule(rule) {
  if (rule === 90) return "single";
  if (rule === 110) return "centerSprinkle";
  return "centerSprinkle";
}

export default function TiltEdgeECAFullscreen() {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  const [rule, setRule] = useState(110);
  const lut = useMemo(() => makeRuleLUT(rule), [rule]);

  const [running, setRunning] = useState(true);
  const [motionOn, setMotionOn] = useState(true);
  const tiltRef = useRef({ beta: 0, gamma: 0, edge: null, speed01: 0 });

  const [manualEdge, setManualEdge] = useState(null); // "left"|"right"|"top"|"bottom"|null
  const [activeEdge, setActiveEdge] = useState("bottom");

  // Zoom: smaller cellSize => more cells visible (zoom out)
  const [cellSize, setCellSize] = useState(2);

  // Seed modes to help Rule 110 fill the screen
  const [seedMode, setSeedMode] = useState(defaultSeedModeForRule(110));
  const [sprinkleProb, setSprinkleProb] = useState(0.02); // for centerSprinkle

  // Viewport-derived CA dimensions (W=space width, H=time depth)
  const dimsRef = useRef({ W: 0, H: 0 });

  // Simulation grid: circular buffer of rows
  const gridRef = useRef({ rows: [], head: 0, current: new Uint8Array(0) });

  function computeDims(edge, cs) {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);

    const timeHorizontal = edge === "left" || edge === "right";
    const gridW = Math.max(8, Math.floor(vw / cs));
    const gridH = Math.max(8, Math.floor(vh / cs));

    // timeHorizontal: displayed width is H and height is W
    const W = timeHorizontal ? gridH : gridW;
    const H = timeHorizontal ? gridW : gridH;

    return { W, H, timeHorizontal };
  }

  function buildInitRow(W, mode, sprinkleP) {
    const init = new Uint8Array(W);

    if (mode === "single") {
      init[Math.floor(W / 2)] = 1;
      return init;
    }

    if (mode === "centerSprinkle") {
      init[Math.floor(W / 2)] = 1;
      for (let i = 0; i < W; i++) {
        if (Math.random() < sprinkleP) init[i] = 1;
      }
      return init;
    }

    // random
    for (let i = 0; i < W; i++) init[i] = Math.random() > 0.5 ? 1 : 0;
    return init;
  }

  function resetSimulation({ edgeOverride = null, keepDims = false } = {}) {
    const edge =
      edgeOverride ??
      (manualEdge ?? (motionOn ? tiltRef.current.edge : null) ?? activeEdge);

    const { W, H } = keepDims
      ? { W: dimsRef.current.W, H: dimsRef.current.H }
      : computeDims(edge || activeEdge, cellSize);

    dimsRef.current = { W, H };

    const init = buildInitRow(W, seedMode, sprinkleProb);
    const rows = Array.from({ length: H }, () => new Uint8Array(W));
    rows[0].set(init);

    gridRef.current = { rows, head: 0, current: init };

    const canvas = canvasRef.current;
    if (canvas) {
      const timeHorizontal =
        (edge || activeEdge) === "left" || (edge || activeEdge) === "right";
      canvas.width = (timeHorizontal ? H : W) * cellSize;
      canvas.height = (timeHorizontal ? W : H) * cellSize;
    }
  }

  // Device orientation listener (Android)
  useEffect(() => {
    function onOri(e) {
      const beta = typeof e.beta === "number" ? e.beta : 0;
      const gamma = typeof e.gamma === "number" ? e.gamma : 0;
      const edge = dominantEdgeFromTilt(beta, gamma);
      const speed01 = speed01FromTilt(beta, gamma);
      tiltRef.current = { beta, gamma, edge, speed01 };
    }

    window.addEventListener("deviceorientation", onOri, true);
    return () => window.removeEventListener("deviceorientation", onOri, true);
  }, []);

  // Reset on rule/zoom/sprinkle changes
  useEffect(() => {
    resetSimulation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule, cellSize, sprinkleProb]);

  // Reset when seed mode changes
  useEffect(() => {
    resetSimulation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedMode]);

  // Reset when manual edge changes
  useEffect(() => {
    if (manualEdge && manualEdge !== activeEdge) {
      setActiveEdge(manualEdge);
      resetSimulation({ edgeOverride: manualEdge });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualEdge]);

  // Recompute dims on window resize
  useEffect(() => {
    function onResize() {
      resetSimulation({ keepDims: false });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellSize, seedMode, sprinkleProb, rule, motionOn, manualEdge, activeEdge]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });

    let lastT = performance.now();
    let stepAccumulator = 0;

    function tick(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      const desiredEdge =
        manualEdge ?? (motionOn ? tiltRef.current.edge : null) ?? activeEdge;

      if (desiredEdge && desiredEdge !== activeEdge) {
        setActiveEdge(desiredEdge);
        resetSimulation({ edgeOverride: desiredEdge });
      }

      const edge = desiredEdge || activeEdge;

      // Ensure dims still match viewport + zoom + edge
      const { W, H } = dimsRef.current;
      const { W: W2, H: H2 } = computeDims(edge, cellSize);
      if (W !== W2 || H !== H2) resetSimulation({ edgeOverride: edge });

      // Tilt-based speed
      const s01 = tiltRef.current.speed01;
      const minSps = 30;
      const maxSps = 800;
      const stepsPerSec = minSps + (maxSps - minSps) * Math.pow(s01, 1.35);

      if (running) {
        stepAccumulator += dt * stepsPerSec;
        const steps = Math.max(1, Math.floor(stepAccumulator));
        stepAccumulator -= steps;

        for (let s = 0; s < steps; s++) {
          const g = gridRef.current;
          const next = stepECA(g.current, lut);
          g.current = next;
          g.head = (g.head + 1) % g.rows.length;
          g.rows[g.head].set(next);
        }
      }

      // Draw
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";

      const g = gridRef.current;
      const { W: w, H: h } = dimsRef.current;

      for (let t = 0; t < h; t++) {
        const bufIdx = (g.head - (h - 1 - t) + h) % h;
        const row = g.rows[bufIdx];
        for (let x = 0; x < w; x++) {
          if (row[x] !== 1) continue;
          const { sx, sy } = mapToScreen(edge, t, x, w, h);
          const gridWidth = edge === "left" || edge === "right" ? h : w;
          const gridHeight = edge === "left" || edge === "right" ? w : h;
          if (sx < 0 || sx >= gridWidth || sy < 0 || sy >= gridHeight) continue;
          ctx.fillRect(sx * cellSize, sy * cellSize, cellSize, cellSize);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lut, running, motionOn, manualEdge, activeEdge, cellSize, rule, seedMode, sprinkleProb]);

  return (
    <div style={{ width: "100vw", height: "100vh", margin: 0, overflow: "hidden", background: "#fff" }}>
      <canvas
        ref={canvasRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          display: "block",
          touchAction: "none",
        }}
      />

      {/* Controls overlay */}
      <div
        style={{
          position: "fixed",
          left: 12,
          bottom: 12,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          padding: 10,
          border: "1px solid #ddd",
          borderRadius: 10,
          background: "rgba(255,255,255,0.9)",
          backdropFilter: "blur(6px)",
          maxWidth: "min(980px, calc(100vw - 24px))",
        }}
      >
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Rule
          <input
            type="number"
            min={0}
            max={255}
            value={rule}
            onChange={(e) => setRule(clamp(parseInt(e.target.value || "0", 10), 0, 255))}
            style={{ width: 84 }}
          />
        </label>

        <button onClick={() => setRunning((v) => !v)}>{running ? "Pause" : "Play"}</button>
        <button onClick={() => resetSimulation()}>Reset</button>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={motionOn} onChange={(e) => setMotionOn(e.target.checked)} />
          Motion
        </label>

        <span style={{ opacity: 0.7 }}>|</span>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Seed
          <select value={seedMode} onChange={(e) => setSeedMode(e.target.value)}>
            <option value="single">Single (centre)</option>
            <option value="centerSprinkle">Centre + sprinkle</option>
            <option value="random">Random</option>
          </select>
        </label>

        {seedMode === "centerSprinkle" && (
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            Sprinkle
            <input
              type="range"
              min={0}
              max={0.15}
              step={0.005}
              value={sprinkleProb}
              onChange={(e) => setSprinkleProb(parseFloat(e.target.value))}
            />
            <span style={{ width: 48, textAlign: "right" }}>{Math.round(sprinkleProb * 100)}%</span>
          </label>
        )}

        <span style={{ opacity: 0.7 }}>|</span>

        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={{ opacity: 0.9 }}>Zoom</span>
          <button onClick={() => setCellSize((s) => clamp(s + 1, 1, 10))}>+</button>
          <button onClick={() => setCellSize((s) => clamp(s - 1, 1, 10))}>-</button>
          <span style={{ width: 48, textAlign: "right" }}>{cellSize}px</span>
        </div>

        <span style={{ opacity: 0.7 }}>|</span>

        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={{ opacity: 0.8 }}>Edge</span>
          <button onClick={() => setManualEdge(null)} style={{ fontWeight: manualEdge === null ? 700 : 400 }}>
            Auto
          </button>
          {["left", "right", "top", "bottom"].map((e) => (
            <button key={e} onClick={() => setManualEdge(e)} style={{ fontWeight: manualEdge === e ? 700 : 400 }}>
              {e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}