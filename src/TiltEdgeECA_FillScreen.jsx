import React, { useEffect, useMemo, useRef, useState } from "react";

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function makeRuleLUT(rule) {
  // index 0..7 corresponds to neighborhood 000..111
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

// Map CA coordinates (t,x) -> screen-grid coords (sx,sy) depending on edge.
// Here, “screen-grid” is the logical grid we draw into at 1px per cell.
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
  // CA size in cells (increase W/H if you want “more world”, zoom controls show more/less)
  const W = 400; // space width in cells
  const H = 260; // history depth in rows (time)

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  const [rule, setRule] = useState(110);
  const lut = useMemo(() => makeRuleLUT(rule), [rule]);

  const [running, setRunning] = useState(true);

  // Fill mode: "fit" preserves aspect ratio (letterbox), "stretch" fills both axes (distorts)
  const [fillMode, setFillMode] = useState("fit");

  // Zoom multiplier applied on top of fit/stretch scale
  const [zoom, setZoom] = useState(1);

  // Motion steering
  const [motionOn, setMotionOn] = useState(true);
  const tiltRef = useRef({ beta: 0, gamma: 0, edge: null });

  // Manual edge override
  const [manualEdge, setManualEdge] = useState(null);
  const [activeEdge, setActiveEdge] = useState("bottom");

  // Ring buffer for CA rows
  const gridRef = useRef({
    rows: Array.from({ length: H }, () => new Uint8Array(W)),
    head: 0,
    current: new Uint8Array(W),
  });

  // Offscreen pixel buffer (1px per cell)
  // Logical grid dims depend on edge (time horizontal swaps axes)
  const offscreenRef = useRef({
    w: W,
    h: H,
    imageData: null, // ImageData
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

  // Device orientation listener
  useEffect(() => {
    function onOri(e) {
      const beta = typeof e.beta === "number" ? e.beta : 0;
      const gamma = typeof e.gamma === "number" ? e.gamma : 0;
      const edge = dominantEdgeFromTilt(beta, gamma);
      tiltRef.current = { beta, gamma, edge };
    }
    window.addEventListener("deviceorientation", onOri, true);
    return () => window.removeEventListener("deviceorientation", onOri, true);
  }, []);

  useEffect(() => {
    resetSimulation({ random: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    resetSimulation({ random: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule]);

  // Resize canvas to container
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      // devicePixelRatio for crispness
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
    // Logical grid dims:
    // bottom/top: (W x H)
    // left/right: (H x W)
    const gw = edge === "left" || edge === "right" ? H : W;
    const gh = edge === "left" || edge === "right" ? W : H;

    const o = offscreenRef.current;
    if (!o.imageData || o.w !== gw || o.h !== gh) {
      // Create ImageData (RGBA) of gw x gh
      const tmp = document.createElement("canvas");
      const tctx = tmp.getContext("2d");
      o.w = gw;
      o.h = gh;
      o.imageData = tctx.createImageData(gw, gh);
    }
    return { gw, gh, imageData: offscreenRef.current.imageData };
  }

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
        // keep accumulator bounded
        stepAccumulator = Math.min(stepAccumulator, 2);
      }

      // Offscreen draw at 1px per cell
      const { gw, gh, imageData } = ensureOffscreen(edge);
      const data = imageData.data;

      // Clear to white
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }

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

      // Put ImageData into a tiny temp canvas, then scale to main canvas
      const tmp = document.createElement("canvas");
      tmp.width = gw;
      tmp.height = gh;
      const tctx = tmp.getContext("2d");
      tctx.putImageData(imageData, 0, 0);

      // Compute scale to fill the canvas
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

      // Clear & draw
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, gw, gh, dx, dy, drawW, drawH);

      // HUD
      ctx.fillStyle = "#000";
      ctx.font = `${Math.max(12, Math.floor(12 * (window.devicePixelRatio || 1)))}px sans-serif`;
      ctx.fillText(
        `Rule ${rule} | Edge ${edge} | ${fillMode} | zoom ${zoom.toFixed(2)}`,
        12,
        18
      );

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [activeEdge, fillMode, lut, manualEdge, motionOn, rule, running, zoom]);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          Rule:&nbsp;
          <input
            type="number"
            min={0}
            max={255}
            value={rule}
            onChange={(e) => setRule(clamp(parseInt(e.target.value || "0", 10), 0, 255))}
            style={{ width: 90 }}
          />
        </label>

        <button onClick={() => setRunning((v) => !v)}>{running ? "Pause" : "Play"}</button>
        <button onClick={() => resetSimulation({ random: false })}>Reset (single seed)</button>
        <button onClick={() => resetSimulation({ random: true })}>Reset (random)</button>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={motionOn} onChange={(e) => setMotionOn(e.target.checked)} />
          Motion steering
        </label>

        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Fill:&nbsp;
          <select value={fillMode} onChange={(e) => setFillMode(e.target.value)}>
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
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ opacity: 0.8 }}>Manual edge:</span>
        <button onClick={() => setManualEdge(null)} style={{ fontWeight: manualEdge === null ? 700 : 400 }}>
          Auto
        </button>
        {(["left", "right", "top", "bottom"]).map((e) => (
          <button key={e} onClick={() => setManualEdge(e)} style={{ fontWeight: manualEdge === e ? 700 : 400 }}>
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
          height: "70vh", // fills most of the screen
          display: "block",
          position: "relative",
          background: "#fff",
        }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>

      <div style={{ marginTop: 10, opacity: 0.85 }}>
        This version fills the screen by scaling the rendered CA (no shifting, no expanding, no wrap). If you want “more CA
        world”, increase W/H constants.
      </div>
    </div>
  );
}