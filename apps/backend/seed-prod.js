const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const argon2 = require("argon2");
const p = new PrismaClient();
const K = Buffer.from(process.env.ENCRYPTION_KEY, "hex");

function enc(s) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", K, iv);
  const e = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString("base64");
}

async function main() {
  const lines = fs.readFileSync("/app/logins_valid.csv", "utf8").trim().split("\n").slice(1);
  console.log("Total:", lines.length);
  var ok = 0, skip = 0, er = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = line.match(/^([^,]+),"([^"]*)","([^"]*)",([^,]+),(\d+),([^,]+),(\d+)/);
    if (!m) continue;
    var email = m[1], pw = m[2], name = m[3], ih = m[4], ip = m[5], sh = m[6], sp = m[7];
    try {
      var exists = await p.user.findUnique({ where: { email: email } });
      if (exists) { skip++; continue; }
      var h = await argon2.hash(pw, { type: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      await p.$transaction(async function(t) {
        var u = await t.user.create({
          data: { name: name || email.split("@")[0], email: email, passwordHash: h }
        });
        await t.mailAccount.create({
          data: {
            userId: u.id,
            displayName: name || email.split("@")[0],
            emailAddress: email,
            username: email,
            encryptedPassword: enc(pw),
            incomingHost: ih,
            incomingPort: parseInt(ip),
            outgoingHost: sh,
            outgoingPort: parseInt(sp),
            tlsMode: "TLS",
            syncState: "PENDING"
          }
        });
      });
      ok++;
      if (ok % 50 === 0) console.log("Criados:", ok);
    } catch(e) {
      er++;
      if (er <= 3) console.error(email, e.message);
    }
  }
  console.log("PRONTO! Criados:", ok, "Pulados:", skip, "Erros:", er);
}

main().finally(function() { p.$disconnect(); });
