/** Rendu de la solution : superposition sur la photo, ou grille propre. */

import { FILLED, UNKNOWN } from './solver.js';
import { node } from './vision.js';

/** Interpolation bilinéaire dans un quadrilatère [tl, tr, br, bl]. */
export function quadPoint(quad, u, v) {
  const [tl, tr, br, bl] = quad;
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

/** Projection (u, v) → pixel via un quadrilatère à quatre coins. */
export function quadMapper(quad) {
  return (u, v) => quadPoint(quad, u, v);
}

/**
 * Projection (u, v) → pixel en suivant le maillage détecté : chaque case
 * garde sa forme réelle, courbure de la page comprise.
 *
 * (u, v) parcourt la table telle qu'elle a été détectée, indépendamment du
 * nombre de cases qu'on lui attribue. Compter une case de plus resserre le
 * découpage ; cela ne déplace pas le cadre et ne fait pas sortir la lecture
 * du maillage — l'ancienne version avançait d'une maille par case et, dès
 * que la taille corrigée dépassait la détection, lisait au-delà du tableau,
 * ce qui repliait les coins sur la rangée suivante.
 */
export function meshMapper(mesh, sr, sc) {
  const R = mesh.hLines.length - 1;
  const C = mesh.vLines.length - 1;
  return (u, v) => {
    const fc = sc + Math.min(1, Math.max(0, u)) * (C - sc);
    const fr = sr + Math.min(1, Math.max(0, v)) * (R - sr);
    const j = Math.min(C - 1, Math.floor(fc));
    const i = Math.min(R - 1, Math.floor(fr));
    const tu = fc - j;
    const tv = fr - i;
    const a = node(mesh, i, j);
    const b = node(mesh, i, j + 1);
    const d = node(mesh, i + 1, j + 1);
    const e = node(mesh, i + 1, j);
    const top = { x: a.x + (b.x - a.x) * tu, y: a.y + (b.y - a.y) * tu };
    const bot = { x: e.x + (d.x - e.x) * tu, y: e.y + (d.y - e.y) * tu };
    return { x: top.x + (bot.x - top.x) * tv, y: top.y + (bot.y - top.y) * tv };
  };
}

/** Quadrilatère englobant la grille de jeu, extrait du maillage. */
export function quadFromMesh(mesh, sr, sc) {
  const R = mesh.hLines.length - 1;
  const C = mesh.vLines.length - 1;
  return [node(mesh, sr, sc), node(mesh, sr, C), node(mesh, R, C), node(mesh, R, sc)];
}

/**
 * Dessine la photo puis la solution par-dessus.
 * @param {object} o
 * @param {CanvasRenderingContext2D} o.ctx
 * @param {HTMLCanvasElement} o.photo
 * @param {{x:number,y:number}[]} o.quad
 * @param {Int8Array} o.grid
 */
export function renderOverlay({
  ctx, photo, map, grid, rows, cols,
  opacity = 0.72, color = '#1b2b6b', showGrid = true, showHandles = false, dim = 0.15,
}) {
  const { canvas } = ctx;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (photo) ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);

  const sx = canvas.width / (photo ? photo.width : canvas.width);
  const sy = canvas.height / (photo ? photo.height : canvas.height);
  const P = (u, v) => {
    const p = map(u, v);
    return { x: p.x * sx, y: p.y * sy };
  };

  if (dim > 0) {
    ctx.fillStyle = `rgba(255,255,255,${dim})`;
    ctx.beginPath();
    const c = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.fill();
  }

  if (grid) {
    const quad = (c, r) => {
      const a = P(c / cols, r / rows);
      const b = P((c + 1) / cols, r / rows);
      const d = P((c + 1) / cols, (r + 1) / rows);
      const e = P(c / cols, (r + 1) / rows);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(d.x, d.y);
      ctx.lineTo(e.x, e.y);
      ctx.closePath();
    };
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r * cols + c] !== FILLED) continue;
        quad(c, r);
        ctx.fill();
      }
    }
    // Case non tranchée : elle se voit, sans se faire passer pour une réponse.
    ctx.globalAlpha = opacity * 0.5;
    ctx.fillStyle = '#9aa3b5';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r * cols + c] !== UNKNOWN) continue;
        quad(c, r);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  if (showGrid) {
    ctx.strokeStyle = 'rgba(214,64,52,0.85)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) {
      ctx.lineWidth = c % 5 === 0 ? 2 : 0.7;
      ctx.beginPath();
      for (let r = 0; r <= rows; r++) {
        const p = P(c / cols, r / rows);
        if (r === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      ctx.lineWidth = r % 5 === 0 ? 2 : 0.7;
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) {
        const p = P(c / cols, r / rows);
        if (c === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  if (showHandles) {
    const corners = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
    corners.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d64034';
      ctx.stroke();
    });
  }
  ctx.restore();
}

/** Rendu autonome de la solution, sans la photo. */
export function renderCleanGrid(canvas, grid, rows, cols, cell = 16) {
  const pad = cell;
  canvas.width = cols * cell + pad * 2;
  canvas.height = rows * cell + pad * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r * cols + c];
      if (v === FILLED) ctx.fillStyle = '#14213d';
      else if (v === UNKNOWN) ctx.fillStyle = '#c9cedb';
      else continue;
      ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  for (let c = 0; c <= cols; c++) {
    ctx.lineWidth = c % 5 === 0 ? 1.6 : 0.5;
    ctx.beginPath();
    ctx.moveTo(pad + c * cell, pad);
    ctx.lineTo(pad + c * cell, pad + rows * cell);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.lineWidth = r % 5 === 0 ? 1.6 : 0.5;
    ctx.beginPath();
    ctx.moveTo(pad, pad + r * cell);
    ctx.lineTo(pad + cols * cell, pad + r * cell);
    ctx.stroke();
  }
  return canvas;
}
