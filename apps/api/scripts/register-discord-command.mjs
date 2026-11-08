const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !botToken) {
  console.error('Faltan DISCORD_APPLICATION_ID o DISCORD_BOT_TOKEN.');
  process.exit(1);
}

const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify([{
    name: 'synex-login',
    description: 'Inicia sesión o crea una cuenta de Synex Obfuscador',
    type: 1,
  }]),
});

if (!response.ok) {
  console.error('Discord rechazó el registro del comando:', response.status, await response.text());
  process.exit(1);
}

console.log('Comando global /synex-login registrado correctamente.');
