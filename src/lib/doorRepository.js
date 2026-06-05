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
      `SELECT p.door_id, p.name, p.device_id, d.status 
       FROM portoes.portoes_emerg_registrados p
       LEFT JOIN (
           SELECT DISTINCT ON (device_id) device_id, status
           FROM portoes.device_stats
           ORDER BY device_id, last_signal DESC
       ) d ON p.device_id = d.device_id`
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

  return insertRes.rows[0];
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

export const getIdByName = async (nome) => {
  try {
    const result = await pool.query(` 
      SELECT door_id from portoes.portoes_emerg_registrados
      WHERE device_id = $1
    `, [nome])
    
    return result?.rows[0].door_id
  } catch (error) {
    console.error("Erro ao buscar id pelo nome do device: ", error);
    
  }
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

export async function upsertDeviceSignal(deviceId, status = 'online') {
  if (!deviceId) return;
  try {
    const last = await pool.query(`
      SELECT id, status FROM portoes.device_stats
      WHERE device_id = $1
      ORDER BY last_signal DESC
      LIMIT 1
    `, [deviceId]);

    if (last.rowCount > 0 && last.rows[0].status === status) {
      await pool.query(`
        UPDATE portoes.device_stats 
        SET last_signal = now() 
        WHERE id = $1
      `, [last.rows[0].id]);
    } else {
      await pool.query(`
        INSERT INTO portoes.device_stats (device_id, status, last_signal)
        VALUES ($1, $2, now())
      `, [deviceId, status]);
    }
  } catch (error) {
    console.error("Erro ao atualizar sinal do dispositivo: ", error);
  }
}

export async function setDeviceOffline(deviceId) {
  return upsertDeviceSignal(deviceId, 'offline');
}
