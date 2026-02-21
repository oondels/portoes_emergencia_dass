const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.USERS,
  password: process.env.PASS,
  host: process.env.IP,
  port: process.env.PORT,
  database: process.env.DBASE,
});

pool.connect().then(client => {
  console.log(`Conectado ao banco de dados ${process.env.IP} com sucesso!`);
  client.release();
})
.catch(error => {
  console.error("Erro ao conectar ao banco de dados: ", error);
})

module.exports = { pool };
