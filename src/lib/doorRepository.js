import { pool } from "../db.cjs";

// Retorna lista de portões existentes no histórico
export async function getDistinctDoors() {
  const res = await pool.query(
    `SELECT DISTINCT portao FROM portoes.portoes_emergencia ORDER BY portao`
  );
  return res.rows.map((r) => r.portao);
}

export async function getOrInsertDoor(door) {
  if (!door) {
    const res = await pool.query(
      `SELECT door_id, name FROM portoes.portoes_emerg_registrados`
    );

    return res?.rows || []
  }

  const res = await pool.query(
    `SELECT door_id, name FROM portoes.portoes_emerg_registrados WHERE door_id = $1`,
    [door.doorId]
  );

  if (res.rows.length > 0) {
    return res.rows[0];
  }

  const insertRes = await pool.query(
    `INSERT INTO portoes.portoes_emerg_registrados (door_id, name) VALUES ($1, $2) RETURNING door_id, name`,
    [door.doorId, door.name]
  );

  return insertRes.rows[0].portao;
}

// Últimas aberturas por portão
export async function getLastOpenings({ doorId, limit = 5 }) {
  const result = await pool.query(
    `SELECT date
         FROM portoes.portoes_emergencia
        WHERE status = true AND portao = $1
        ORDER BY date DESC
        LIMIT $2`,
    [doorId, limit]
  );

  return result.rows;
}

// Insere evento de portão (status true/false). Se date não informado, usa timezone São Paulo.
export async function recordDoorEvent(doorId, status, date = null) {
  if (date) {
    return pool.query(
      `INSERT INTO portoes.portoes_emergencia (portao, status, date)
       VALUES ($1, $2, $3) RETURNING *`,
      [doorId, status, date]
    );
  }
  return pool.query(
    `INSERT INTO portoes.portoes_emergencia (portao, status, date)
     VALUES ($1, $2, NOW() AT TIME ZONE 'America/Sao_Paulo') RETURNING *`,
    [doorId, status]
  );
}

// Última linha completa (para comparação de mudança)
export async function getLatestRow(doorId) {
  const res = await pool.query(
    `SELECT * FROM portoes.portoes_emergencia
     WHERE portao = $1
     ORDER BY date DESC
     LIMIT 1`,
    [doorId]
  );
  return res.rows[0] || null;
}
