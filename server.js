const fs = require('fs');
const path = require('path');
const { Client, ChannelType, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder } = require('discord.js');
const prism = require('prism-media');
const { getPcmFiles, convertPcmToMp3, mergeMp3Files, cleanUp } = require('./convert');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  EndBehaviorType,
  createWriteStream
} = require('@discordjs/voice');
const mongoose = require('mongoose');


mongoose.connect('mongodb://localhost:27017/Participant', {
    // Больше нет необходимости использовать useNewUrlParser и useUnifiedTopology
}).then(() => {
    console.log('Connected to MongoDB');
}).catch(err => {
    console.error('Could not connect to MongoDB', err);
});

// Схема Mongoose для участников
const participantSchema = new mongoose.Schema({
  userId: String,
  role: String,
  wins: { type: Number, default: 0 },
  losses: { type: Number, default: 0 }
});

const Participant = mongoose.model('Participant', participantSchema);


const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates]
});

let audioStream;
let lastResultsMessageId = null;

function convertAndMergeRecordings() {
  const folderPath = './recordings'; // Путь к папке с PCM файлами
  const outputFolderPath = './converted'; // Путь к папке для сохранения MP3 файлов
  const currentDate = new Date();
  const timestamp = currentDate.toISOString().replace(/:/g, '-'); // Замена символов ':' на '-', чтобы имя файла было допустимым
  const mergedFilePath = `./converted/merged_output_${timestamp}.mp3`; // Путь к конечному объединенному файлу с датой и временем

  if (!fs.existsSync(outputFolderPath)) {
      fs.mkdirSync(outputFolderPath);
  }

  const pcmFiles = getPcmFiles(folderPath);
  convertPcmToMp3(folderPath, outputFolderPath, pcmFiles);
  mergeMp3Files(outputFolderPath, mergedFilePath, folderPath);
}

const ROLE_IDS = {
  "Глава правительства": "1183139600693207150",
  "Член правительства": "1183218234690904084",
  "Глава оппозиции": "1186738499798454363",
  'Судья': "1186752109652230204",
  "Член оппозиции": "1186738528139362425"
};

let registrationOpen = true;

client.once('ready', () => {
  console.log('Bot is online!');
});
let votingResults = {
  voteGovernment: 0,
  voteOpposition: 0
};
async function finalizeVotingAndAssignResults(guild, channels) {
  // Определение победителя
  let winnerRole;
  let loserRole;
  if (votingResults.voteGovernment > votingResults.voteOpposition) {
    winnerRole = 'government';
    loserRole = 'opposition';
  } else {
    winnerRole = 'opposition';
    loserRole = 'government';
  }

  // Обновление записей в базе данных
  const governmentRoleIds = [ROLE_IDS['Глава правительства'], ROLE_IDS['Член правительства']];
  const oppositionRoleIds = [ROLE_IDS['Глава оппозиции'], ROLE_IDS['Член оппозиции']];

  const updateWins = winnerRole === 'government' ? governmentRoleIds : oppositionRoleIds;
  const updateLosses = loserRole === 'government' ? governmentRoleIds : oppositionRoleIds;

  // Увеличиваем количество побед у победителей
  await Participant.updateMany(
    { 'userId': { $in: updateWins } },
    { $inc: { wins: 1 } }
  );

  // Увеличиваем количество поражений у проигравших
  await Participant.updateMany(
    { 'userId': { $in: updateLosses } },
    { $inc: { losses: 1 } }
  );

  // Возвращение судей в канал "Трибуна" и вывод результатов
  await returnJudgesToTribune(guild, channels.judgeChannel.id, channels.tribuneChannel.id);
  await postOrUpdateDebateResults(channels.textChannelId);

  // Сброс результатов голосования для следующего использования
  votingResults = {
    voteGovernment: 0,
    voteOpposition: 0
  };
}

async function startRecording(guild, channelId) {
  const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
  });

  try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20e3);
      const receiver = connection.receiver;

      receiver.speaking.on('start', userId => {
          console.log(`Пользователь ${userId} начал говорить.`);
          const opusStream = receiver.subscribe(userId, {
              end: {
                  behavior: EndBehaviorType.AfterSilence,
                  duration: 100,
              },
          });

          // Используем преобразователь из prism-media для декодирования Opus в PCM
          const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
          const outputStream = fs.createWriteStream(`./recordings/${userId}-${Date.now()}.pcm`);
          opusStream.pipe(opusDecoder).pipe(outputStream);
          audioStream = opusStream; // Сохраняем поток для остановки записи
      });

      receiver.speaking.on('end', userId => {
          console.log(`Пользователь ${userId} закончил говорить.`);
      });
  } catch (error) {
      console.error('Ошибка при подключении к каналу:', error);
      connection.destroy();
  }
}

function stopRecording() {
  if (audioStream) {
      audioStream.destroy(); // Завершаем запись
      audioStream = null;
  }
}
async function postOrUpdateDebateResults(channelId) {
  try {
    // Получаем участников, отсортированных по количеству побед
    const participants = await Participant.find({}).sort({ wins: -1, losses: 1 }).limit(20);

    // Форматируем список участников для сообщения
    let resultsMessage = '**Топ победителей**\n';
    participants.forEach((participant, index) => {
      resultsMessage += `${index + 1}. <@${participant.userId}>: ${participant.wins} побед\n`;
    });

    // Получаем канал по его ID
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      if (lastResultsMessageId) {
        // Обновляем существующее сообщение с результатами
        const messageToUpdate = await channel.messages.fetch(lastResultsMessageId);
        if (messageToUpdate) {
          await messageToUpdate.edit(resultsMessage);
          console.log('Сообщение с результатами обновлено');
        }
      } else {
        // Отправляем новое сообщение с результатами
        const message = await channel.send(resultsMessage);
        lastResultsMessageId = message.id; // Сохраняем идентификатор сообщения для последующих обновлений
        console.log('Сообщение с результатами отправлено');
      }
    } else {
      console.log('Канал не найден');
    }
  } catch (error) {
    console.error('Ошибка при отправке результатов дебатов:', error);
  }
}
async function endDebate(guild, channels) {
  // Перемещение всех участников в "Обсуждение"
  convertAndMergeRecordings();
  const discussionChannelId = obsujdenieChannel.id;
  guild.members.fetch().then(members => {
      members.forEach(member => {
          if (member.voice.channel) {
              member.voice.setChannel(discussionChannelId).catch(console.error);
              member.voice.setMute(false).catch(console.error);
          }
      });
  }).catch(console.error);

  // Удаление ролей и скрытие каналов
  ['Глава правительства', 'Член правительства', 'Глава оппозиции', 'Член оппозиции', 'Судья'].forEach(roleName => {
      const roleId = ROLE_IDS[roleName];
      guild.roles.fetch(roleId).then(role => {
          role.members.forEach(member => {
              member.roles.remove(roleId).catch(console.error);
          });
      }).catch(console.error);
  });

  // Скрытие созданных голосовых каналов
  Object.values(channels).forEach(channel => {
      guild.channels.cache.get(channel.id).delete().catch(console.error);
  });
}

client.on('messageCreate', async message => {
  if (message.content === '!create') {
    await Participant.deleteMany({});
    const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('Запись на дебаты АПФ').addFields(
      { name: 'Список дебатёров:', value: 'Нет участников', inline: true },
      { name: 'Список судей:', value: 'Нет участников', inline: true }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('registerDebater').setLabel('Записаться как дебатер').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('registerJudge').setLabel('Записаться как судья').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('unregister').setLabel('Отписаться').setStyle(ButtonStyle.Danger));
    const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });
    lastmessageId = sentMessage.id;
    await message.delete();
  }
});

client.on('interactionCreate', async interaction => {
  if (!registrationOpen) {
    await interaction.reply({ content: 'Регистрация закрыта.', ephemeral: true });
    return;
  }

  
  if (interaction.isButton()) {
    if (interaction.customId === 'endDebate') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(ROLE_IDS['Судья'])) {
          // Логика завершения дебатов и перемещения всех в "Обсуждение"
          stopRecording(); // Останавливаем запись
          endDebate(guild, channels);
      } else {
          interaction.reply({ content: 'Только судьи могут завершить дебаты.', ephemeral: true });
      }
  }
  if (interaction.isButton() && (interaction.customId === 'voteGovernment' || interaction.customId === 'voteOpposition')) {
    votingResults[interaction.customId]++; // Увеличиваем счетчик голосов
    await interaction.reply({ content: `Ваш голос за ${interaction.customId.replace('vote', '')} учтен!`, ephemeral: true });
  }
  
    if (interaction.customId === 'registerDebater') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasDebaterRole = member.roles.cache.some(role => role.name === 'Дебатер АПФ 🎓');
      if (hasDebaterRole) {
        const isRegistered = await Participant.findOne({ userId: interaction.user.id });
        if (!isRegistered) {
          const count = await Participant.countDocuments({ role: 'debater' });
          if (count < 4) {
            const newParticipant = new Participant({ userId: interaction.user.id, role: 'debater' });
            await newParticipant.save();
            
            await interaction.reply({ content: `${interaction.user.username} зарегистрирован(а) как дебатер!`, ephemeral: true });
          } else {
            await interaction.reply({ content: 'Достигнуто максимальное количество дебатеров.', ephemeral: true });
          }
        } else {
          await interaction.reply({ content: 'Вы уже зарегистрированы в одной из ролей.', ephemeral: true });
        }
      } else {
        await interaction.reply({ content: 'Для регистрации как дебатер, вы должны иметь роль "Дебатер АПФ 🎓".', ephemeral: true });
      }
    } else if (interaction.customId === 'registerJudge') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasJudgeRole = member.roles.cache.some(role => role.name === 'Судья АПФ 🎓');
      if (hasJudgeRole) {
        const isRegistered = await Participant.findOne({ userId: interaction.user.id });
        if (!isRegistered) {
          const count = await Participant.countDocuments({ role: 'judge' });
          if (count < 3) {
            const newParticipant = new Participant({ userId: interaction.user.id, role: 'judge' });
            await newParticipant.save();
            await interaction.reply({ content: `${interaction.user.username} зарегистрирован(а) как судья!`, ephemeral: true });
          } else {
            await interaction.reply({ content: 'Достигнуто максимальное количество судей.', ephemeral: true });
          }
        } else {
          await interaction.reply({ content: 'Вы уже зарегистрированы в одной из ролей.', ephemeral: true });
        }
      } else {
        await interaction.reply({ content: 'Для регистрации как судья, вы должны иметь роль "Судья АПФ 🎓".', ephemeral: true });
      }
    } else if (interaction.customId === 'unregister') {
      await Participant.deleteOne({ userId: interaction.user.id });
      await interaction.reply({ content: `${interaction.user.username} удален(а) из списка дебатеров и судей.`, ephemeral: true });
    }
  }

  const messageToUpdate = await interaction.channel.messages.fetch(lastmessageId);

  const debaters = await Participant.find({ role: 'debater' });
  const debatersList = debaters.map(p => `<@${p.userId}>`).join('\n') || 'Нет участников';

  const judges = await Participant.find({ role: 'judge' });
  const judgesList = judges.map(p => `<@${p.userId}>`).join('\n') || 'Нет участников';


  const embedToUpdate = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('Запись на дебаты АПФ')
    .addFields(
      { name: 'Список дебатёров:', value: debatersList, inline: true },
      { name: 'Список судей:', value: judgesList, inline: true }
    )
    .setTimestamp();

  await messageToUpdate.edit({ embeds: [embedToUpdate] });

  async function createDebateChannels(guild) {
    const categoryId = "1144371822951932077"; // ID категории
    const existingChannels = await guild.channels.fetch();
    const channelNames = ['Судейская', 'Трибуна', 'Правительство', 'Оппозиция', 'Обсуждение'];
  
    // Проверка существующих каналов в указанной категории
    let channels = { judgeChannel: null, tribuneChannel: null, governmentChannel: null, oppositionChannel: null };
    let channelsExist = false;
  
    existingChannels.filter(channel => channel.parentID === categoryId).forEach(channel => {
      if (channelNames.includes(channel.name)) {
        channelsExist = true;
        channels[channel.name.toLowerCase() + 'Channel'] = channel;
      }
    });
  
    console.log("Список всех каналов в категории " + categoryId + ":");
    existingChannels.filter(channel => channel.parentID === categoryId).forEach(channel => {
      console.log(channel.name + " - " + channel.id);
    });
  
    if (channelsExist) {
      console.log('Каналы уже созданы.');
  
      return channels;
    }

    try {
      // Создаем голосовые каналы в определенной категории
      const judgeChannel = await guild.channels.create({ 
        name: 'Судейская', 
        type: ChannelType.GuildVoice,
        parent: categoryId
      });
      const tribuneChannel = await guild.channels.create({ 
        name: 'Трибуна', 
        type: ChannelType.GuildVoice,
        parent: categoryId
      });
      const governmentChannel = await guild.channels.create({ 
        name: 'Правительство', 
        type: ChannelType.GuildVoice,
        parent: categoryId
      });
      const oppositionChannel = await guild.channels.create({ 
        name: 'Оппозиция', 
        type: ChannelType.GuildVoice,
        parent: categoryId
      });
      const obsujdenieChannel = await guild.channels.create(
        {
          name: 'Обсуждение',
          type: ChannelType.GuildVoice,
          parent: categoryId
        }
      );
          
      
      // Добавляем кнопки голосования в текстовый канал
      const voteEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Голосование')
        .setDescription('Нажмите на кнопку для голосования');
  
      const voteButtons = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('voteGovernment')
            .setLabel('Правительство')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('voteOpposition')
            .setLabel('Оппозиция')
            .setStyle(ButtonStyle.Danger)
        );
  
        return { judgeChannel, tribuneChannel, governmentChannel, oppositionChannel};
    } catch (error) {
      console.error('Ошибка при создании каналов:', error);
    }
  }

  const debatersCount = await Participant.countDocuments({ role: 'debater' });
  const judgesCount = await Participant.countDocuments({ role: 'judge' });
  
  if (debatersCount >= 1 && judgesCount >= 0) {
    const channel = interaction.channel; // Сохраняем ссылку на канал

    setTimeout(async () => {
      registrationOpen = false;

      const debaters = await Participant.find({ role: 'debater' }).exec();
      const debatersIds = debaters.map(p => p.userId);
      
      // Случайно перемешиваем список дебатеров
      const shuffledDebaters = debatersIds.sort(() => 0.5 - Math.random());
      // Выбираем первые четыре дебатера для ролей
      const selectedDebaters = shuffledDebaters.slice(0, 4);
      // Назначаем роли дебатерам
      const debaterRoles = ["Глава правительства", "Член правительства", "Глава оппозиции", "Член оппозиции"];
      let roleAssignments = [];

      for (let i = 0; i < selectedDebaters.length; i++) {
        const memberId = selectedDebaters[i];
        const role = debaterRoles[i % debaterRoles.length];
        const roleId = ROLE_IDS[role];
        try {
          const member = await interaction.guild.members.fetch(memberId);
          await member.roles.add(roleId);
          console.log(`Role ${role} assigned to ${member.user.username}`);
          roleAssignments.push({ userId: memberId, role });
        } catch (error) {
          console.error(`Error assigning role ${role} to user ${memberId}:`, error);
        }
      }
      const judges = await Participant.find({ role: 'judge' }).exec();
      const judgesIds = judges.map(p => p.userId);
      const shuffledJudges = judgesIds.sort(() => 0.5 - Math.random());
      const selectedJudges = shuffledJudges.slice(0, 1); // Выбираем до 3-х судей
      for (let i = 0; i < selectedJudges.length; i++) {
        const judgeId = selectedJudges[i];
        try {
          const judgeMember = await interaction.guild.members.fetch(judgeId);
          await judgeMember.roles.add(ROLE_IDS["Судья"]);
          console.log(`Role Судья assigned to ${judgeMember.user.username}`);
        } catch (error) {
          console.error(`Error assigning role Судья to user ${judgeId}:`, error);
        }
      }

      // Обновление участников в participants.json
      async function updateParticipants(selectedDebaters, selectedJudges) {
        // Обновление ролей для дебатеров
        await Promise.all(selectedDebaters.map(async (userId) => {
          await Participant.updateOne({ userId }, { $set: { role: 'debater' } });
        }));
      
        // Обновление ролей для судей
        await Promise.all(selectedJudges.map(async (userId) => {
          await Participant.updateOne({ userId }, { $set: { role: 'judge' } });
        }));
      }
      
      const channels = await createDebateChannels(interaction.guild);
      const tribuneChannelId = channels.tribuneChannel.id;


      // Функция для проверки и мутинга участников в канале "Трибуна"
function checkParticipantsAndPlaySound(guild, tribuneChannelId, allParticipantsIds, channels) {
    const checkInterval = setInterval(async () => {
      const tribuneChannel = await guild.channels.fetch(tribuneChannelId); // Используйте tribuneChannelId
      tribuneChannel.members.forEach(member => {
        // Замутить всех участников, кроме бота
        if (!member.user.bot) {
          member.voice.setMute(true).catch(console.error);
        }
      });
        const membersInChannel = tribuneChannel.members;

        // Изменение условия проверки наличия всех участников
        const allParticipantsPresent = allParticipantsIds.length === 0 || allParticipantsIds.every(id => membersInChannel.has(id));
        if (allParticipantsPresent) {
            console.log('Все участники в канале. Начинаем воспроизведение звука.');
            startRecording(guild, tribuneChannelId); // Запускаем запись
            clearInterval(checkInterval);
            playSound(guild, tribuneChannelId, channels); // Убедитесь, что функция вызывается корректно
        } else {
            console.log('Ожидание участников...');
        }
    }, 5000); // Проверять каждые 5 секунд
}

async function playSound(guild, voiceChannelId, channels) {
  const connection = joinVoiceChannel({
      channelId: voiceChannelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  let currentSound = 1; // Для отслеживания текущего воспроизводимого файла

  const playResource = (resourcePath) => {
    return new Promise((resolve) => {
        const resource = createAudioResource(path.join(__dirname, resourcePath));
        player.play(resource);
        player.once('idle', () => resolve());
    });
};

  const waitForIdle = () => new Promise(resolve => player.once('idle', resolve));
  const topicsData = JSON.parse(fs.readFileSync('debateTopics.json', 'utf8'));
  const topics = topicsData.topics;
  const randomTopic = topics[Math.floor(Math.random() * topics.length)]; // Выбираем случайную тему

  while (currentSound <= 10) {
      switch (currentSound) {
        case 1:
          await playResource('Запись 1.mp3');
          break;
      case 2:
          await playResource('Запись 2.mp3');
          break;
      case 3:
        const textChannel = guild.channels.cache.find(channel => channel.id === channels.tribuneChannel.id);
        textChannel.send(`Тема дебатов: ${randomTopic}`);
        await playResource('Запись 3.mp3');
        await moveAndUnmuteMembers(guild, channels);
        break;
        case 4:
              playResource('Запись 4.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Глава правительства'], 1);
              break;
          case 5:
              playResource('Запись 5.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Глава оппозиции'], 1);
              break;
          case 6:
              playResource('Запись 6.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Член правительства'], 1);
              break;
          case 7:
              playResource('Запись 7.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Член оппозиции'], 8);
              break;
          case 8:
              playResource('Запись 8.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Глава оппозиции'], 4);
              break;
          case 9:
              playResource('Запись 9.mp3');
              await waitForIdle();
              await unmuteParticipant(guild, channels.tribuneChannel.id, ROLE_IDS['Глава правительства'], 1);
              break;
          case 10:
              playResource('Запись 10.mp3');
              await waitForIdle();
              await moveJudges(guild, channels, true); // Передаем флаг, что нужно обработать голосование
              break;
      }
      currentSound++;
  }
}


async function moveJudges(guild, channels, handleVoting = false) {
  const judgeRoleId = ROLE_IDS['Судья'];
  const judgeChannelId = channels.judgeChannel.id;

  // Перемещаем судей в канал "Судейская"
  const judges = await guild.roles.cache.get(judgeRoleId).members;
  judges.forEach(judge => {
      judge.voice.setChannel(judgeChannelId).catch(console.error);
      judge.voice.setMute(false);
  });

  if (handleVoting) {
      // Создаем сообщение с кнопками для голосования
      const votingMessage = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Голосование за лучших дебатеров')
          .setDescription('Выберите команду, которая, по вашему мнению, показала лучшие ораторские навыки.');

      const votingButtons = new ActionRowBuilder()
          .addComponents(
              new ButtonBuilder()
                  .setCustomId('voteOpposition')
                  .setLabel('Оппозиция')
                  .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                  .setCustomId('voteGovernment')
                  .setLabel('Правительство')
                  .setStyle(ButtonStyle.Danger)
          );

      // Находим текстовый канал, связанный с каналом "Судейская"
      const judgeTextChannel = guild.channels.cache.find(channel => channel.id === channels.judgeTextChannel.id);

      if (judgeTextChannel) {
          await judgeTextChannel.send({ embeds: [votingMessage], components: [votingButtons] });
      }

      // Устанавливаем таймер на 10 минут для голосования
      setTimeout(async () => {
        await finalizeVotingAndAssignResults(guild, channels);
      }, 3000); // 10 минут в миллисекундах
  }
}

async function unmuteParticipant(guild, channelID, roleID, duration) {
  return new Promise(async (resolve, reject) => {
      const tribuneChannel = await guild.channels.fetch(channelID);
      const participant = tribuneChannel.members.find(member => member.roles.cache.has(roleID));

      if (participant) {
          try {
              await participant.voice.setMute(false);
              setTimeout(async () => {
                  await participant.voice.setMute(true);
                  resolve();
              }, duration * 60 * 1000); // Преобразование в миллисекунды
          } catch (error) {
              console.error(error);
              reject(error);
          }
      } else {
          resolve(); // Если участник не найден, все равно разрешаем Promise
      }
  });
}


async function moveAndUnmuteMembers(guild, channels) {
  return new Promise(async resolve => {
    console.log('Начало перемещения участников');

    // Получаем канал "Трибуна" и его участников
    const tribuneChannel = await guild.channels.fetch(channels.tribuneChannel.id);
    const membersInTribune = tribuneChannel.members;

    // Перебираем участников, исключая ботов
    membersInTribune.forEach(member => {
      if (!member.user.bot) {
        console.log(`Перемещаем участника: ${member.user.username}`);
        if (member.roles.cache.has(ROLE_IDS['Глава правительства']) || member.roles.cache.has(ROLE_IDS['Член правительства'])) {
          member.voice.setChannel(channels.governmentChannel.id).catch(console.error);
        } else if (member.roles.cache.has(ROLE_IDS['Глава оппозиции']) || member.roles.cache.has(ROLE_IDS['Член оппозиции'])) {
          member.voice.setChannel(channels.oppositionChannel.id).catch(console.error);
        }
        member.voice.setMute(false).catch(console.error);
      }
    });

    // Устанавливаем таймер на 15 минут, затем возвращаем и размучиваем всех участников
    setTimeout(() => {
      console.log('Возвращаем участников в канал "Трибуна" и размучиваем');
      membersInTribune.forEach(member => {
        if (!member.user.bot && (member.voice.channelId === channels.governmentChannel.id || member.voice.channelId === channels.oppositionChannel.id)) {
          // Возвращаем в канал "Трибуна"
          member.voice.setChannel(channels.tribuneChannel.id).catch(console.error);
          // Мутим всех участников
          member.voice.setMute(true).catch(console.error);
        }
      });

      resolve(); // Завершаем Promise после всех действий
    }, 5000); // 15 минут в миллисекундах
  });
}



      
      const connection = joinVoiceChannel({
        channelId: channels.tribuneChannel.id, // Используйте .id напрямую от tribuneChannel
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
    });
    
    connection.on(VoiceConnectionStatus.Ready, async () => {
      console.log('Бот подключился к голосовому каналу "Трибуна"');
      
      // Получаем список ID дебатеров и судей из MongoDB
      const debaters = await Participant.find({ role: 'debater' }).exec();
      const judges = await Participant.find({ role: 'judge' }).exec();
  
      const debatersIds = debaters.map(p => p.userId);
      const judgesIds = judges.map(p => p.userId);
  
      const allParticipantsIds = [...debatersIds, ...judgesIds];
  
      // Вызываем функцию проверки и мутинга участников
      checkParticipantsAndPlaySound(interaction.guild, channels.tribuneChannel.id, allParticipantsIds, channels);
  });
  
        }, 3000);
  }
});

client.login('MTE0MTMzNjg5MjQzMjk5MDI4OA.GhUhQY.qX-S-Pyj6LOLz3jOK32ZYyZkqIMJmR7g7I1KWk');

