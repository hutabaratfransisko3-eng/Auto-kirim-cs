const fs = require('fs');
const path = require('path');
const {
    Client: BotClient,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    ChannelType
} = require('discord.js');
const { Client: SelfClient } = require('discord.js-selfbot-v13');

// --- ENVIRONMENT VARIABLES (DARI RAILWAY) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID || process.env.CLIENT_ID;
const USER_TOKEN = process.env.USER_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

// --- PENYIMPANAN KONFIGURASI LOKAL ---
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
    let saved = {};
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        } catch (e) {
            console.error('[CONFIG] Gagal membaca config.json:', e.message);
        }
    }
    return {
        controlChannelId: saved.controlChannelId || process.env.CONTROL_CHANNEL_ID || null,
        targetChannelId: saved.targetChannelId || process.env.TARGET_CHANNEL_ID || null,
        isMonitoring: saved.isMonitoring ?? false
    };
}

function saveConfig(newConfig) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
}

let config = loadConfig();

// --- INISIALISASI CLIENT ---
const bot = new BotClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const selfbot = new SelfClient({
    checkUpdate: false
});

// State Antrean & Eksekusi
let queuedData = null;
let isSending = false;

// --- DEFINISI SLASH COMMANDS ---
const commands = [
    new SlashCommandBuilder()
        .setName('setchanel')
        .setDescription('Set channel untuk panel pengaturan & input CS')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Pilih channel pengaturan (kosongkan untuk memakai channel saat ini)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName('settarget')
        .setDescription('Set ID channel tujuan request CS di server RP')
        .addStringOption(option =>
            option
                .setName('channel_id')
                .setDescription('Masukkan ID Channel tujuan (Klik kanan channel > Copy Channel ID)')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('start')
        .setDescription('Mulai memantau channel tujuan dan aktifkan auto-forward CS')
].map(cmd => cmd.toJSON());

// --- FUNGSI CEK IZIN KIRIM DI CHANNEL TUJUAN ---
function canSendInTarget(channel) {
    if (!channel || !channel.guild) return false;
    const me = channel.guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    return perms && perms.has('VIEW_CHANNEL') && perms.has('SEND_MESSAGES');
}

// --- FUNGSI EKSEKUSI FORWARD ---
async function executeForward() {
    if (!config.isMonitoring || !queuedData || !config.targetChannelId || isSending) return;
    isSending = true;

    try {
        const targetChannel = await selfbot.channels.fetch(config.targetChannelId);
        if (!targetChannel) throw new Error('Channel tujuan tidak ditemukan oleh akun pengirim.');

        if (!canSendInTarget(targetChannel)) {
            isSending = false;
            return; // Masih terkunci, tunggu event terbuka
        }

        let sentMessage = null;

        // 1. Coba Native Forward terlebih dahulu
        try {
            const sourceChannel = await selfbot.channels.fetch(queuedData.channelId);
            const sourceMessage = await sourceChannel.messages.fetch(queuedData.messageId);

            if (typeof sourceMessage.forward === 'function') {
                sentMessage = await sourceMessage.forward(targetChannel);
            }
        } catch (fwdErr) {
            console.log('[INFO] Native forward dilewati, beralih ke exact copy-send:', fwdErr.message);
        }

        // 2. Fallback Exact Copy-Send (teks & file 100% utuh tanpa diubah)
        if (!sentMessage) {
            const payload = {};
            if (queuedData.content) payload.content = queuedData.content;
            if (queuedData.attachments && queuedData.attachments.length > 0) {
                payload.files = queuedData.attachments;
            }
            sentMessage = await targetChannel.send(payload);
        }

        const sentUrl = sentMessage.url;
        queuedData = null; // Kosongkan antrean setelah sukses
        config.isMonitoring = false; // Matikan monitoring otomatis setelah sukses terkirim 1x
        saveConfig(config);

        // Kirim notifikasi sukses ke Channel Pengaturan
        if (config.controlChannelId) {
            const controlChannel = await bot.channels.fetch(config.controlChannelId).catch(() => null);
            if (controlChannel) {
                const successEmbed = new EmbedBuilder()
                    .setColor(0x00FF7F)
                    .setTitle('✅ Character Story Berhasil Terkirim!')
                    .setDescription(`Akun **${selfbot.user.tag}** baru saja me-forward CS ke <#${config.targetChannelId}>.`)
                    .addFields(
                        { name: 'Link Pesan', value: `[Klik untuk membuka pesan](${sentUrl})`, inline: true },
                        { name: 'Status Monitor', value: '⏸️ Berhenti otomatis (gunakan `/start` untuk sesi berikutnya)', inline: true }
                    )
                    .setTimestamp();

                await controlChannel.send({
                    content: OWNER_ID ? `<@${OWNER_ID}>` : undefined,
                    embeds: [successEmbed]
                });
            }
        }
    } catch (error) {
        console.error('[ERROR EXECUTE FORWARD]:', error);
        if (config.controlChannelId) {
            const controlChannel = await bot.channels.fetch(config.controlChannelId).catch(() => null);
            if (controlChannel) {
                await controlChannel.send(`⚠️ **Gagal mengirim CS:** \`${error.message}\`\nAntrean masih tersimpan dan sistem tetap memantau.`);
            }
        }
    } finally {
        isSending = false;
    }
}

// --- EVENT SELFBOT (PEMANTAU CHANNEL TUJUAN) ---
selfbot.on('ready', () => {
    console.log(`[SELFBOT] Login sebagai ${selfbot.user.tag}`);
});

selfbot.on('channelUpdate', async (oldChannel, newChannel) => {
    if (!config.isMonitoring || !config.targetChannelId) return;
    if (newChannel.id !== config.targetChannelId) return;
    if (!queuedData) return;

    if (canSendInTarget(newChannel)) {
        console.log(`[SNIPER] Channel ${newChannel.name} TERBUKA! Mengeksekusi forward...`);
        await executeForward();
    }
});

selfbot.on('roleUpdate', async () => {
    if (!config.isMonitoring || !config.targetChannelId || !queuedData) return;
    const targetChannel = selfbot.channels.cache.get(config.targetChannelId);
    if (targetChannel && canSendInTarget(targetChannel)) {
        console.log(`[SNIPER] Role updated & Channel TERBUKA! Mengeksekusi forward...`);
        await executeForward();
    }
});

// --- EVENT BOT CONTROLLER (SLASH COMMANDS & INPUT CS) ---
bot.on('ready', async () => {
    console.log(`[BOT CONTROLLER] Online sebagai ${bot.user.tag}`);

    const appId = APPLICATION_ID || bot.user.id;
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        console.log(`[SLASH COMMANDS] Berhasil mendaftarkan command ke App ID: ${appId}`);
    } catch (err) {
        console.error('[SLASH COMMANDS ERROR]:', err);
    }
});

bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Validasi hanya Owner yang bisa menggunakan Slash Command
    if (OWNER_ID && interaction.user.id !== OWNER_ID) {
        return interaction.reply({ content: '❌ Kamu tidak memiliki izin menggunakan command ini.', ephemeral: true });
    }

    const { commandName } = interaction;

    // 1. /setchanel
    if (commandName === 'setchanel') {
        const selectedChannel = interaction.options.getChannel('channel') || interaction.channel;
        config.controlChannelId = selectedChannel.id;
        saveConfig(config);

        return interaction.reply({
            content: `✅ **Channel Pengaturan berhasil di-set ke <#${selectedChannel.id}>!**\nSilakan kirim link Pastebin CS beserta lampiran gambar di channel tersebut.`
        });
    }

    // 2. /settarget
    if (commandName === 'settarget') {
        const targetId = interaction.options.getString('channel_id').trim();
        await interaction.deferReply();

        try {
            const targetChannel = await selfbot.channels.fetch(targetId);
            if (!targetChannel) {
                return interaction.editReply('❌ Channel tujuan tidak ditemukan. Pastikan ID benar dan akun pengirim sudah join di server tersebut.');
            }

            config.targetChannelId = targetId;
            saveConfig(config);

            const isOpen = canSendInTarget(targetChannel);
            return interaction.editReply(
                `✅ **Channel Tujuan CS berhasil di-set!**\n` +
                `• **Nama Channel:** #${targetChannel.name} (\`${targetId}\`)\n` +
                `• **Server:** ${targetChannel.guild?.name || 'Unknown'}\n` +
                `• **Status Saat Ini:** ${isOpen ? '🔓 TERBUKA' : '🔒 TERKUNCI'}`
            );
        } catch (err) {
            return interaction.editReply(`❌ Gagal mengakses channel ID \`${targetId}\`: \`${err.message}\`\nPastikan akun pengirim sudah berada di dalam server tujuan.`);
        }
    }

    // 3. /start
    if (commandName === 'start') {
        if (!config.controlChannelId) {
            return interaction.reply('❌ Channel pengaturan belum diatur. Jalankan `/setchanel` terlebih dahulu.');
        }
        if (!config.targetChannelId) {
            return interaction.reply('❌ Channel tujuan CS belum diatur. Jalankan `/settarget` terlebih dahulu.');
        }

        config.isMonitoring = true;
        saveConfig(config);

        const targetChannel = await selfbot.channels.fetch(config.targetChannelId).catch(() => null);
        const isOpen = canSendInTarget(targetChannel);

        if (queuedData && isOpen) {
            await interaction.reply('🚀 **Monitoring Aktif!** Channel tujuan sudah **TERBUKA** dan antrean CS tersedia. Mengirim sekarang...');
            return executeForward();
        }

        return interaction.reply(
            `🚀 **Sistem Auto-Forward CS AKTIF!**\n` +
            `• **Channel Pengaturan:** <#${config.controlChannelId}>\n` +
            `• **Channel Tujuan:** <#${config.targetChannelId}> (${isOpen ? '🔓 TERBUKA' : '🔒 TERKUNCI'})\n` +
            `• **Status Antrean:** ${queuedData ? '✅ Format CS sudah siap di antrean!' : '⚠️ Belum ada pesan CS. Silakan kirim link Pastebin + gambar di channel pengaturan.'}`
        );
    }
});

bot.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!config.controlChannelId || message.channel.id !== config.controlChannelId) return;
    if (OWNER_ID && message.author.id !== OWNER_ID) return;

    const text = message.content.trim();

    // Command tambahan: !status
    if (text.toLowerCase() === '!status') {
        const targetChannel = config.targetChannelId
            ? selfbot.channels.cache.get(config.targetChannelId)
            : null;
        const isOpen = canSendInTarget(targetChannel);

        const statusEmbed = new EmbedBuilder()
            .setColor(config.isMonitoring ? 0x00FF7F : 0xFFA500)
            .setTitle('📊 Status Sistem Auto-Forward CS')
            .addFields(
                { name: 'Mode Monitor (`/start`)', value: config.isMonitoring ? '🟢 AKTIF' : '⏸️ NONAKTIF', inline: true },
                { name: 'Akun Pengirim', value: selfbot.user ? `🟢 ${selfbot.user.tag}` : '🔴 Offline', inline: true },
                { name: 'Channel Tujuan', value: config.targetChannelId ? `<#${config.targetChannelId}> (${isOpen ? '🔓 Terbuka' : '🔒 Terkunci'})` : '❌ Belum di-set', inline: false },
                { name: 'Antrean CS', value: queuedData ? '⏳ Tersimpan & siap dikirim' : '📭 Kosong', inline: false }
            );
        return message.reply({ embeds: [statusEmbed] });
    }

    // Command tambahan: !batal
    if (text.toLowerCase() === '!batal') {
        if (!queuedData) return message.reply('❌ Tidak ada CS yang sedang mengantre.');
        queuedData = null;
        return message.reply('🗑️ Antrean CS berhasil dihapus.');
    }

    // Simpan pesan baru sebagai data yang akan di-forward
    const attachmentUrls = message.attachments.map(att => att.url);
    if (!text && attachmentUrls.length === 0) return;

    queuedData = {
        messageId: message.id,
        channelId: message.channel.id,
        content: message.content,
        attachments: attachmentUrls
    };

    if (!config.isMonitoring) {
        return message.reply(
            '📥 **Draft CS berhasil disimpan!**\n' +
            'Namun sistem monitoring belum berjalan. Ketik `/start` jika sudah siap memantau channel tujuan.'
        );
    }

    const targetChannel = config.targetChannelId
        ? await selfbot.channels.fetch(config.targetChannelId).catch(() => null)
        : null;

    if (canSendInTarget(targetChannel)) {
        await message.reply('🔓 Channel tujuan sedang **TERBUKA**! Langsung me-forward pesan sekarang...');
        await executeForward();
    } else {
        await message.reply(
            '⏳ **CS masuk antrean & pemantauan aktif!**\n' +
            `Menunggu <#${config.targetChannelId}> dibuka oleh admin...`
        );
    }
});

// Jalankan kedua client
selfbot.login(USER_TOKEN);
bot.login(BOT_TOKEN);
