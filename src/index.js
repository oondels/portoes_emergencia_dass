import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  getLastOpenings,
  getOrInsertDoor,
  recordDoorEvent,
  getLatestRow,
} from "./lib/doorRepository.js"
import { createTransporter } from "./lib/mailer.js";

const app = express();
const port = 3028;
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

// const transporter = createTransporter();

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use((req, res, next) => {
  req.io = io;
  next();
});

// Heartbeat genérico por portão 
const heartbeatInterval = 5000; // 5 segundos
const DOOR_TTL_MS = 4 * heartbeatInterval;
const doors = new Map();
const watchers = new Map();

const roomFor = (doorId) => { return `door:${doorId}`; }

function normalizeDoorId(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function upsertDoor(doorId, socket, name) {
  const now = Date.now();
  const prev = doors.get(doorId);

  getOrInsertDoor({ doorId, name }).catch((err) => {
    console.error("Erro ao inserir/obter portão:", err);
  });

  doors.set(doorId, { status: socket.status, socketId: socket.id, doorId, name, lastBeatAt: now, alive: true, lastConnections: [] });
  socket.join(roomFor(doorId));

  // Se existia outro socket pra mesma porta, derruba
  if (prev && prev.socketId !== socket.id) {
    io.sockets.sockets.get(prev.socketId)?.disconnect(true);
  }
}

function markBeat(doorId) {
  // TODO: Verificar Errro de envio de HeartBeat ao client
  const porta = doors.get(doorId);
  if (!porta) {
    console.warn("Porta não encontrada:", doorId);
    return
  };

  porta.lastBeatAt = Date.now();
  if (!porta.alive) {
    porta.alive = true;

    io.to(roomFor(doorId)).emit("heartbeat", { door: doorId, alive: true });
  }
}

function handleDisconnect(door) {
  if (!door) return;

  const doorId = door.doorId;
  console.log(`Perca de sinal da porta ${door.name}, desconectando.`);

  const doorSocket = io.sockets.sockets.get(door.socketId);
  doors.delete(doorId);
  doorSocket?.disconnect(true);

  io.to(roomFor(doorId)).emit("door_disconnect", {
    door: doorId, alive: false, timeStamp: new Date()
  });

  console.log("Portas conectadas:", doors.size);
  console.log("Sockets conectados:", io.sockets.sockets.size);

  // Sinaliza os Watchers a disconexão do portão
  watchers.forEach((watcher) => {
    io.to(watcher.socketId).emit("door_disconnect", {
      door: doorId, alive: false, timeStamp: new Date()
    });
  });
}

io.on("connection", (socket) => {
  socket.data.state = "init";
  socket.emit("start_conclude_connection");

  socket.once("conclude_connection", async (data) => {
    if (data?.type === "watcher") {
      socket.type = "watcher"
      socket.data.state = "ready";
      socket.data.lastBeatAt = Date.now();
      socket.data.alive = true;
      socket.data.name = typeof data?.name === "string" ? data.name.trim() : "Monitorador";

      watchers.set(data.id, {
        id: data.id,
        socketId: socket.id,
        browser: data.browser || "unknown",
        deviceOs: data.os || "unknown",
        deviceType: data.deviceType || "unknown",
        lastBeatAt: socket.data.lastBeatAt,
        alive: socket.data.alive,
      });
      console.log('Watcher connected');
      return;
    }

    const doorId = data?.door;
    const name = typeof data?.name === "string" ? data.name.trim() : undefined;
    if (!doorId) return socket.disconnect(true);

    console.info("Porta conectada:", name, "Door ID:", doorId);

    socket.data.state = "ready";
    socket.data.doorId = doorId;
    socket.data.name = name;
    socket.type = 'door'
    socket.status = data.status || false;

    // TODO: Coletar ultimas aberturas do portão e armazenar

    upsertDoor(doorId, socket, name);
    socket.emit("conclude_ack", { door: doorId });

    // Notifica todos os watchers que uma porta conectou
    try {
      let lastUpdate = "";
      try {
        const lastOppening = await getLastOpenings({ doorId, limit: 1 });
        lastUpdate = lastOppening.length
          ? new Date(lastOppening[0].date).toLocaleString("pt-BR")
          : "";
      } catch (err) {
        console.error("Erro ao obter última abertura:", err);
      }

      watchers.forEach((watcher) => {
        io.to(watcher.socketId).emit("door_connected", {
          door: doorId,
          name,
          status: socket.status || false,
          lastUpdate,
        });
      });
    } catch (err) {
      console.error("Erro ao notificar watchers sobre porta conectada:", err);
    }
  })

  socket.on("heartbeat", (data) => {
    // Heartbeat de monitorador
    if (data.type === "watcher") {
      const now = Date.now();
      socket.data.lastBeatAt = now;
      socket.data.alive = true;

      socket.emit("heartbeat_ack", { type: "watcher", alive: true, date: now });
      return;
    }

    const doorId = socket.data?.doorId || data?.door;
    if (!doorId) {
      console.warn("Door ID não encontrado");
      return
    };

    markBeat(doorId);
    socket.emit("heartbeat_ack", { door: doorId });
  });

  socket.on("last_openings", async (payload = {}) => {
    try {
      const searchedDoor = doors.get(payload.door);

      const limit = Number(payload?.limit) > 0 ? Number(payload.limit) : 5;
      const openings = await getLastOpenings({ doorId: searchedDoor.doorId, limit });
      searchedDoor.lastOppenings = openings.map(r => r.date);

      doors.set(searchedDoor.doorId, {
        ...searchedDoor,
        lastOppenings: openings,
      })
      socket.emit("last_openings", searchedDoor);
    } catch (err) {
      console.error("Erro ao carregar últimas aberturas:", err);
      // TODO: Implementar tratamento de erro no client com id da porta em especifico
      // socket.emit("last_openings_error", { message: "Falha ao consultar aberturas." });
    }
  });

  socket.on("get_all_doors", async () => {
    const doors = await getOrInsertDoor()
    socket.emit("all_doors_response", doors);
  });

  socket.on("get_connected_doors", async () => {
    const connected = [];
    for (const [doorId, doorInfo] of doors) {
      if (doorInfo.alive) {
        const lastOppening = await getLastOpenings({ doorId, limit: 1 })
        connected.push({
          door: doorId,
          name: doorInfo.name,
          status: doorInfo.status || false,
          lastOppenings: [],
          lastUpdate: lastOppening.length ? new Date(lastOppening[0].date).toLocaleString("pt-BR") : ""
        });
      }
    }
    socket.emit("connected_doors", connected);
  });

  socket.on("get_door_status", (payload) => {
    if (doors.size === 0) return;
    console.log("Requisicao de door status update");

    const doorId = normalizeDoorId(payload?.door);
    if (!doorId) {
      socket.emit("door_status", { error: "door_id_missing" });
      return;
    }

    const doorInfo = doors.get(doorId);
    if (!doorInfo) {
      socket.emit("door_status", { door: doorId, error: "door_not_found" });
      return;
    }

    io.to(roomFor(doorId)).emit("get_door_status", { door: doorId });
  })

  socket.on("door_status", (data) => {
    const doorId = normalizeDoorId(data?.door);
    if (!doorId) {
      console.warn("door_status: door_id_missing");
      return;
    }

    const doorInfo = doors.get(doorId);
    if (!doorInfo) {
      console.warn("door_status: door_not_found", doorId);
      return;
    }

    doorInfo.status = data.status;
    doors.set(doorId, doorInfo);

    watchers.forEach((watcher) => {
      io.to(watcher.socketId).emit("door_status_response", { door: doorId, status: data.status });
    });
    // socket.emit("door_status_response", { door: doorId, status: data.status });
  })

  socket.on("disconnect", () => {
    console.log('Disconnecting');

    const door = doors.get(String(socket.data?.doorId));
    handleDisconnect(door || null);
  });
});


// Varredura periódica
setInterval(() => {
  if (doors.size === 0) return;

  const now = Date.now();
  console.log('Heartbeat check - doors connected:', doors.size);

  // Verifica portas
  for (const [door, doorInfo] of doors.entries()) {
    const alive = now - doorInfo.lastBeatAt <= DOOR_TTL_MS;
    doorInfo.alive = alive;

    if (!alive) {
      handleDisconnect(doorInfo);
    }
  }
}, heartbeatInterval);


app.get("/", (req, res) => {
  res.status(200).send("Hello World, portas emergência.");
});

app.post("/portao_emerg", async (req, res) => {
  const { open, door, offline_mode, offline_openings } = req.body;
  const currentDate = new Date();

  const currentDoor = doors.get(String(door));
  if (!currentDoor) {
    return res.status(404).json({ error: "Portão não encontrado." });
  }
  currentDoor.status = open;

  const data = {
    status: open,
    date: currentDate.toLocaleString("pt-BR"),
    door: door,
  };
  let error = false;

  try {
    if (offline_mode) {
      if (offline_openings && offline_openings.length > 0) {
        let offlineError = false;
        for (let i = 0; i < offline_openings.length; i++) {
          const formattedDate = parsePtBrDateToISO(offline_openings[i]);
          const postOfflineOppenings = await recordDoorEvent(door, true, formattedDate);

          if (postOfflineOppenings.rows.length === 0) {
            console.error("Erro ao postar abertura offline.");
            offlineError = true;
          }
        }

        if (offlineError) {
          return res.status(500).json({ message: "Erro ao salvar dados no banco de dados." });
        } else {
          return res.status(200).json({ message: "Dados enviados com sucesso." });
        }
      }
    } else {
      req.io.emit("portao_emerg", data);

      if (open) {
        watchers.forEach((watcher) => {
          io.to(watcher.socketId).emit("door_open", data);
        });
      } else {
        watchers.forEach((watcher) => {
          io.to(watcher.socketId).emit("door_closed", data);
        });
      }
      console.log("Dados recebidos do portão de emergência:", data);

      const lastRow = await getLatestRow(door);

      if (!lastRow) {
        // console.error("Portão não encontrado");
        return res.status(404).json({ error: "Portão não encontrado." });
      }

      const updateDataBase = async (status) => {
        const postQuery = await recordDoorEvent(door, status);
        if (postQuery.rows.length === 0) {
          console.error("Erro ao salvar dados no banco de dados.");
          error = true;
        }
      };

      if (lastRow.status === false && open === true) {
        // console.log("Portão aberto:");

        await updateDataBase(true);

        // await transporter
        //   .sendMail({
        //     to: ["tiago.paixao@grupodass.com.br", "portaria.sest@grupodass.com.br", "portaria.sest2@grupodass.com.br"],
        //     subject: `⚠️ Portão de Emergência Aberto ⚠️`,
        //     html: `
        //     <div style="font-family: Arial, sans-serif; color: #FF6F61; line-height: 1.6; max-width: 600px; margin: 0 auto; background-color: #f9f9f9; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);">
        //       <div style="text-align: center; margin-bottom: 20px;">
        //         <h1 style="color: #FF6F61; font-size: 24px; margin: 0;">Portão de Emergência Aberto</h1>
        //       </div>

        //       <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0;">
        //         <h2 style="color: #FF6F61; font-size: 20px; margin: 0 0 10px; text-align: center;"><strong>Automação Dass</strong></h2>

        //         <h1 style="color: #0d9757; font-size: 22px; margin-bottom: 10px;">Mensagem:</h1>
        //         <p style="font-size: 16px; color: #555; background-color: #f4f4f4; padding: 15px; border-radius: 5px; border: 1px solid #ddd;">
        //           O portão de emergência da ${data.door === "1" ? "Expedição" : "Doca"} foi aberto em ${
        //             data.date
        //           }. Por favor, verifique a situação imediatamente!
        //         </p>
        //       </div>

        //       <div style="text-align: center; margin-top: 30px; color: #777; font-size: 14px;">
        //         <p>Este e-mail foi gerado automaticamente. Por favor, não responda.</p>
        //       </div>
        //   </div>
        //     `,
        //   })
        //   .then(() => {
        //     console.log("Email enviado com sucesso.");
        //     return;
        //   })
        //   .catch((error) => {
        //     console.error("Erro ao enviar email de porta de emergência: ", error);
        //   });
      }
      if (lastRow.status === true && open === false) {
        await updateDataBase(false);
      }

      if (error) {
        return res.status(500).json({ error: "Erro ao salvar dados no banco de dados." });
      } else {
        return res.status(200).json({ message: "Informação recebida." });
      }
    }
  } catch (error) {
    console.error("Erro ao receber dados dos portões", error);
    res.status(500).send("Erro interno no servidor:", error);
  }
});

server.listen(port, () => {
  console.log("Server running on port:", port);
});


function parsePtBrDateToISO(str) {
  // Formato esperado: dd/MM/yyyy HH:mm:ss
  const [datePart, timePart] = String(str).split(" ");
  const [day, month, year] = datePart.split("/").map((v) => parseInt(v, 10));
  const [hours = 0, minutes = 0, seconds = 0] = (timePart || "0:0:0").split(":").map((v) => parseInt(v, 10));
  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString();
}
