const taos = require("td2.0-connector");

var conn = taos.connect({
  host: "localhost",
  port: 6030,
  user: "root",
  password: "taosdata",
});
conn.close();
