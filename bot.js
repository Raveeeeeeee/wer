const login = require("@dongdev/fca-unofficial");
const fs = require("fs");
const path = require("path");
const DataManager = require("./dataManager");

const APPSTATE_FILE = "appstate.json";
const COMMAND_COOLDOWN = 3000;
const data = new DataManager();

const DEVELOPER_ID = "100092567839096";
const BOT_USER_ID_TO_DETECT = "61572200383571";
let ADMIN_IDS = [
  "100043486073592",
  "100092567839096",
  "61561004878878",
  "61559295856089",
];

let api = null;
let botUserId = null;
const userCooldowns = new Map();
const unsentMessageHandlers = new Map();
const recentlyAddedUsers = new Map();
const pendingUnsendPrompts = new Map();
const userMessageHistory = new Map();
const spamDetection = new Map();
const unsentSpamTracking = new Map();
const kickedUsersTracking = new Map();

function isDeveloper(userID) {
  return userID === DEVELOPER_ID;
}

function isSuperAdmin(threadID, userID) {
  return data.isSuperAdmin(threadID, userID);
}

function isProtectedUser(threadID, userID) {
  if (userID === DEVELOPER_ID) {
    return true;
  }
  return data.isSuperAdmin(threadID, userID);
}

function isAdmin(threadID, userID) {
  if (isDeveloper(userID)) {
    return true;
  }
  
  if (isSuperAdmin(threadID, userID)) {
    return true;
  }
  
  if (ADMIN_IDS.includes(userID)) {
    return true;
  }
  
  const groupAdmins = data.getGroupAdmins(threadID);
  return groupAdmins.includes(userID);
}

function getUserRole(threadID, userID) {
  if (isDeveloper(userID)) {
    return 'developer';
  }
  
  if (isSuperAdmin(threadID, userID)) {
    return 'super_admin';
  }
  
  if (isAdmin(threadID, userID)) {
    return 'admin';
  }
  
  return 'user';
}

function loadAppState() {
  if (fs.existsSync(APPSTATE_FILE)) {
    try {
      const appState = JSON.parse(fs.readFileSync(APPSTATE_FILE, "utf8"));
      console.log("✓ Loaded existing appstate");
      return appState;
    } catch (error) {
      console.error("✗ Failed to load appstate:", error.message);
      return null;
    }
  }
  console.log("⚠ No appstate.json found. Please login first.");
  console.log("To login: Create appstate.json with your Facebook session cookies");
  return null;
}

function saveAppState(appState) {
  try {
    fs.writeFileSync(APPSTATE_FILE, JSON.stringify(appState, null, 2));
    console.log("✓ Appstate saved");
  } catch (error) {
    console.error("✗ Failed to save appstate:", error.message);
  }
}

async function initializeBot() {
  const appState = loadAppState();
  
  if (!appState) {
    console.error("\n=== LOGIN REQUIRED ===");
    console.error("Please create an appstate.json file with your Facebook session.");
    console.error("You can get this from your browser cookies after logging into Facebook.");
    process.exit(1);
  }

  console.log("🤖 Starting bot login...");
  
  const savedAdmins = data.loadAdminList();
  if (savedAdmins.length > 0) {
    ADMIN_IDS = savedAdmins;
    console.log("✓ Loaded admin list:", ADMIN_IDS);
  }
  
  data.setGlobalAdmins(ADMIN_IDS, [DEVELOPER_ID]);
  console.log("✓ Global admins and protected users set in DataManager");
  
  const loginOptions = {
    forceLogin: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    listenEvents: true,
    autoMarkDelivery: false,
    autoMarkRead: false,
    online: true,
    selfListen: false
  };
  
  return new Promise((resolve, reject) => {
    login({ appState }, loginOptions, (err, fbApi) => {
      if (err) {
        console.error("✗ Login failed:", err);
        console.error("\n⚠️  Your appstate.json may be expired or invalid.");
        console.error("Please get fresh cookies from your browser and update appstate.json");
        reject(err);
        return;
      }

      console.log("✓ Login successful!");
      api = fbApi;
      
      botUserId = api.getCurrentUserID();
      console.log("✓ Bot User ID:", botUserId);

      api.setOptions({
        listenEvents: true,
        selfListen: false,
        updatePresence: true
      });

      saveAppState(api.getAppState());

      setupEventListeners();
      startDailyReset();
      startPeriodicAppStateSave();
      startPeriodicBanCheck();
      startPeriodicFakeWarningCheck();

      console.log("✓ Bot is now running and listening for messages...\n");
      
      setTimeout(() => {
        scanMissedVulgarWords();
      }, 5000);
      
      setTimeout(() => {
        checkAttendanceOnStartup();
      }, 10000);
      
      resolve(api);
    });
  });
}

function setupEventListeners() {
  api.listenMqtt((err, event) => {
    if (err) {
      console.error("Listen error:", err);
      
      if (err.error === "Not logged in" || (err.res && err.res.error === 1357004)) {
        console.error("\n⚠️  SESSION EXPIRED!");
        console.error("Your appstate.json is no longer valid.");
        console.error("Please follow these steps:");
        console.error("1. Open Facebook in your browser and login");
        console.error("2. Use a cookie extension (EditThisCookie or Cookie-Editor) to export cookies");
        console.error("3. Replace the content of appstate.json with the fresh cookies");
        console.error("4. Restart the bot");
        process.exit(1);
      }
      return;
    }

    console.log("📨 Event received:", JSON.stringify(event, null, 2));

    try {
      handleEvent(event);
    } catch (error) {
      console.error("Event handling error:", error);
    }
  });
}

async function handleEvent(event) {
  switch (event.type) {
    case "message":
    case "message_reply":
      await handleMessage(event);
      break;
    case "message_unsend":
      await handleUnsendMessage(event);
      break;
    case "message_reaction":
      await handleReaction(event);
      break;
    case "event":
      await handleGroupEvent(event);
      break;
    default:
      console.log(`⚠️ Unhandled event type: ${event.type}`);
  }
}

async function handleReaction(event) {
  const { threadID, messageID, reaction, senderID } = event;
  
  if (!threadID || !messageID) return;
  
  if (data.isFakeWarningMessage(threadID, messageID)) {
    console.log(`🎭 User ${senderID} reacted to fake warning message ${messageID}`);
    sendMessage(threadID, "Joke lang, uto-uto HAHA");
    data.removeFakeWarningMessage(threadID, messageID);
  }
}

async function handleMessage(event) {
  const { threadID, messageID, body, senderID, attachments } = event;

  console.log("💬 Message received:", {
    threadID,
    messageID,
    body,
    senderID
  });

  data.cacheMessage(messageID, threadID, senderID, body, attachments || []);

  if (!data.isGroupActive(threadID)) {
    console.log(`⏸️ Group ${threadID} is inactive, skipping message processing`);
    const message = body ? body.trim() : "";
    if (message === ".initialize" && isProtectedUser(threadID, senderID)) {
      console.log(`🚀 Allowing .initialize command in inactive group`);
      await handleInitializeCommand(threadID, messageID, senderID);
    }
    return;
  }

  const hasBumpedMessage = event.messageReply && event.messageReply.body;
  if (!body && !hasBumpedMessage) return;
  
  if (event.messageReply && event.messageReply.messageID) {
    const repliedMessageID = event.messageReply.messageID;
    if (data.isFakeWarningMessage(threadID, repliedMessageID)) {
      console.log(`🎭 User ${senderID} replied to fake warning message ${repliedMessageID}`);
      sendMessage(threadID, "Joke lang, uto-uto HAHA");
      data.removeFakeWarningMessage(threadID, repliedMessageID);
      return;
    }
  }

  const message = body ? body.trim() : "";
  
  if (message) {
    await checkMessageSpam(threadID, messageID, senderID, message);
    await checkMentionWarning(threadID, messageID, senderID, message, event);
  }
  
  const isWarningManagementCommand = message.startsWith(".addwarning ") || message.startsWith(".removeword ");
  if (!isWarningManagementCommand) {
    await checkForVulgarWords(threadID, messageID, senderID, message, event);
  }
  
  if (message.startsWith(". ")) {
    const command = message.substring(2).trim();
    sendMessage(threadID, `no spaces .${command}`, messageID);
    return;
  }
  
  console.log("🔍 Processing command:", message);
  
  if (!message.startsWith(".")) return;
  
  if (message === ".help" || message.startsWith(".help ")) {
    console.log("✅ Executing .help command");
    await handleHelpCommand(threadID, messageID, senderID, message);
  } else if (message === ".test") {
    console.log("✅ Executing .test command");
    sendMessage(threadID, "Bot is working! All systems operational.", messageID);
  } else if (message === ".present") {
    console.log("✅ Executing .present command");
    await handlePresentCommand(threadID, messageID, senderID);
  } else if (message === ".attendance") {
    console.log("✅ Executing .attendance command");
    await handleAttendanceCommand(threadID, messageID);
  } else if (message === ".attendancelist") {
    console.log("✅ Executing .attendancelist command");
    await handleAttendanceListCommand(threadID, messageID);
  } else if (message === ".attendancereset") {
    console.log("✅ Executing .attendancereset command");
    await handleAttendanceResetCommand(threadID, messageID, senderID);
  } else if (message === ".resetatt" || message.startsWith(".resetatt ")) {
    console.log("✅ Executing .resetatt command");
    await handleResetAttCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".attendanceexl ")) {
    console.log("✅ Executing .attendanceexl command");
    await handleAttendanceExcludeCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".attendanceback ")) {
    console.log("✅ Executing .attendanceback command");
    await handleAttendanceIncludeCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".setgreeting ") || message.startsWith(".greetings ")) {
    console.log("✅ Executing .setgreeting command");
    await handleSetGreetingCommand(threadID, messageID, senderID, message);
  } else if (message === ".banned") {
    console.log("✅ Executing .banned command");
    await handleBannedCommand(threadID, messageID);
  } else if (message.startsWith(".addwarning ")) {
    console.log("✅ Executing .addwarning command");
    await handleAddWarningKeywordCommand(threadID, messageID, senderID, message);
  } else if (message.startsWith(".removeword ")) {
    console.log("✅ Executing .removeword command");
    await handleRemoveWarningKeywordCommand(threadID, messageID, senderID, message);
  } else if (message.startsWith(".warning ")) {
    console.log("✅ Executing .warning command");
    await handleManualWarningCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".unwarning ")) {
    console.log("✅ Executing .unwarning command");
    await handleUnwarningCommand(threadID, messageID, senderID, event);
  } else if (message === ".warninglist") {
    console.log("✅ Executing .warninglist command");
    await handleWarningListCommand(threadID, messageID);
  } else if (message.startsWith(".ban ")) {
    console.log("✅ Executing .ban command");
    await handleBanCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".unban ")) {
    console.log("✅ Executing .unban command");
    await handleUnbanCommand(threadID, messageID, senderID, event);
  } else if (message === ".warextreme") {
    console.log("✅ Executing .warextreme command");
    await handleWarExtremeCommand(threadID, messageID, senderID);
  } else if (message === ".peace") {
    console.log("✅ Executing .peace command");
    await handlePeaceCommand(threadID, messageID, senderID);
  } else if (message === ".secret") {
    console.log("✅ Executing .secret command");
    await handleSecretCommand(threadID, messageID, senderID);
  } else if (message.startsWith(".info ") || message === ".info me") {
    console.log("✅ Executing .info command");
    await handleInfoCommand(threadID, messageID, senderID, event);
  } else if (message === ".shutdown") {
    console.log("✅ Executing .shutdown command");
    await handleShutdownCommand(threadID, messageID, senderID);
  } else if (message === ".initialize") {
    console.log("✅ Executing .initialize command");
    await handleInitializeCommand(threadID, messageID, senderID);
  } else if (message.startsWith(".kick ")) {
    console.log("✅ Executing .kick command");
    await handleKickCommand(threadID, messageID, senderID, event);
  } else if (message === ".von") {
    console.log("✅ Executing .von command");
    await handleVonCommand(threadID, messageID);
  } else if (message.startsWith(".addmin ")) {
    console.log("✅ Executing .addmin command");
    await handleAddAdminCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".removeadmin ")) {
    console.log("✅ Executing .removeadmin command");
    await handleRemoveAdminCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".supaddmin ")) {
    console.log("✅ Executing .supaddmin command");
    await handleSupAddminCommand(threadID, messageID, senderID, event);
  } else if (message.startsWith(".removebanrecord ")) {
    console.log("✅ Executing .removebanrecord command");
    await handleRemoveBanRecordCommand(threadID, messageID, senderID, event);
  } else if (message === ".adminlist") {
    console.log("✅ Executing .adminlist command");
    await handleAdminListCommand(threadID, messageID);
  } else if (message === ".banall") {
    console.log("✅ Executing .banall command");
    await handleBanAllCommand(threadID, messageID, senderID);
  } else if (message === ".removeallbans") {
    console.log("✅ Executing .removeallbans command");
    await handleRemoveAllBansCommand(threadID, messageID, senderID);
  } else if (message === ".removeallwarnings") {
    console.log("✅ Executing .removeallwarnings command");
    await handleRemoveAllWarningsCommand(threadID, messageID, senderID);
  } else if (message === ".server") {
    console.log("✅ Executing .server command");
    await handleServerCommand(threadID, messageID);
  } else if (message.startsWith(".serverinfo ")) {
    console.log("✅ Executing .serverinfo command");
    await handleServerInfoCommand(threadID, messageID, senderID, message);
  } else {
    await handleInvalidCommand(threadID, messageID, senderID, message);
  }
}

function checkCooldown(senderID, threadID) {
  const key = `${threadID}_${senderID}`;
  const now = Date.now();
  const lastCommand = userCooldowns.get(key);

  if (lastCommand && now - lastCommand < COMMAND_COOLDOWN) {
    return false;
  }

  userCooldowns.set(key, now);
  return true;
}

async function handleHelpCommand(threadID, messageID, senderID, message) {
  const userIsAdmin = isAdmin(threadID, senderID);
  
  const pageMatch = message.match(/\.help\s+(\d+)/);
  const requestedPage = pageMatch ? parseInt(pageMatch[1]) : 1;
  
  const userCommands = [
    ".help - Show this help menu",
    ".test - Check if bot is online",
    ".present - Mark yourself present in attendance",
    ".attendance - View daily attendance list",
    ".attendancelist - View list of members who missed attendance",
    ".warninglist - View all user warnings",
    ".banned - View banned members list",
    ".server - View server IP and port information",
    ".von - Get Von's website link"
  ];
  
  const adminCommands = [
    ".adminlist - View all admins in this group",
    ".attendancereset - Manually reset attendance",
    ".resetatt @user - Reset specific user's absence records",
    ".attendanceexl @user - Temporarily exclude user from attendance",
    ".attendanceback @user - Bring excluded user back to attendance",
    ".setgreeting [text] - Set custom welcome message",
    ".serverinfo [ip:port] - Set server information",
    ".addwarning [word1, word2, ...] - Add auto-warning keywords",
    ".removeword [word1, word2, ...] - Remove warning keywords",
    ".warning @user [reason] - Issue warning to user",
    ".unwarning @user - Remove one warning from user (ADMIN ONLY)",
    ".unwarning me - Remove your own warning (ADMIN ONLY)",
    ".kick @user [reason] - Kick user from group",
    ".ban @user [reason] - Ban and remove user",
    ".unban [Ban ID] - Unban user and add back to group",
    ".shutdown - Disable bot in this group (DEVELOPER & SUPER ADMIN ONLY)",
    ".initialize - Re-enable bot in this group (DEVELOPER & SUPER ADMIN ONLY)"
  ];

  const developerCommands = [
    ".addmin @user - Make user an admin in this group (DEVELOPER & SUPER ADMIN ONLY)",
    ".removeadmin @user - Remove user as admin from this group (DEVELOPER & SUPER ADMIN ONLY)",
    ".removebanrecord @user - Reset a user's ban count to 0 (DEVELOPER & SUPER ADMIN ONLY)",
    ".banall - Ban everyone in the group (DEVELOPER & SUPER ADMIN ONLY)",
    ".removeallbans - Remove all ban records and reset to 3 days duration",
    ".removeallwarnings - Remove all warning records for all users"
  ];

  let availableCommands = [...userCommands];
  if (userIsAdmin) {
    availableCommands = availableCommands.concat(adminCommands);
  }
  if (isProtectedUser(threadID, senderID)) {
    availableCommands = availableCommands.concat(developerCommands);
  }
  
  const commandsPerPage = 5;
  const totalPages = Math.ceil(availableCommands.length / commandsPerPage);
  
  if (requestedPage < 1 || requestedPage > totalPages) {
    sendMessage(threadID, `❌ Invalid page number. You have access to pages: 1-${totalPages}`, messageID);
    return;
  }
  
  const startIndex = (requestedPage - 1) * commandsPerPage;
  const endIndex = Math.min(startIndex + commandsPerPage, availableCommands.length);
  const pageCommands = availableCommands.slice(startIndex, endIndex);
  
  let helpMessage = `🤖 Bot Commands (Page ${requestedPage}/${totalPages})\n\n`;
  pageCommands.forEach(cmd => {
    helpMessage += `${cmd}\n\n`;
  });
  
  if (requestedPage < totalPages) {
    helpMessage += `\nType .help ${requestedPage + 1} for next page`;
  }
  
  sendMessage(threadID, helpMessage.trim(), messageID);
}

async function handlePresentCommand(threadID, messageID, senderID) {
  if (isProtectedUser(threadID, senderID) || isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Admins, the developer, and the super admin are not tracked in attendance!", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) return;

  const userInfo = threadInfo.participantIDs.includes(senderID) 
    ? await getUserInfo(senderID)
    : null;

  if (!userInfo) {
    sendMessage(threadID, "You're not a member of this group!", messageID);
    return;
  }

  const nickname = threadInfo.nicknames?.[senderID] || userInfo.name;
  
  const alreadyPresent = data.markPresent(threadID, senderID, nickname);
  
  if (alreadyPresent) {
    sendMessage(threadID, "kanina kapa present engot.", messageID);
  } else {
    sendMessage(threadID, `✅ ${nickname} marked as present!`, messageID);
  }
}

async function handleAttendanceCommand(threadID, messageID) {
  console.log("🔍 Getting thread info for attendance...");
  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) {
    console.log("❌ Failed to get thread info");
    sendMessage(threadID, "❌ Error: Could not retrieve group information.", messageID);
    return;
  }

  console.log("🔄 Updating group members...");
  await updateGroupMembers(threadID, threadInfo);

  console.log("📊 Getting attendance data...");
  const attendance = data.getAttendance(threadID);
  const today = data.getTodayDate();

  let message = `📋 Attendance for ${today}\n\n`;
  
  if (attendance.members.length === 0) {
    message += "No members found in this group.";
  } else {
    attendance.members.forEach(member => {
      const status = member.present ? "✅" : "❌";
      const displayName = threadInfo.nicknames?.[member.userID] || member.nickname;
      const nicknameText = threadInfo.nicknames?.[member.userID] ? displayName : `${displayName} (Please apply Gamer Tag/Nick Name)`;
      message += `${status} ${nicknameText}\n\n`;
    });
    
    const presentCount = attendance.members.filter(m => m.present).length;
    message += `📊 ${presentCount}/${attendance.members.length} present`;
  }

  console.log("📤 Sending attendance report...");
  sendMessage(threadID, message, messageID);
}

async function handleAttendanceListCommand(threadID, messageID) {
  console.log("🔍 Getting thread info for missed attendance...");
  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) {
    console.log("❌ Failed to get thread info");
    sendMessage(threadID, "❌ Error: Could not retrieve group information.", messageID);
    return;
  }

  console.log("🔄 Updating group members...");
  await updateGroupMembers(threadID, threadInfo);

  console.log("📊 Getting missed attendance list...");
  const missedList = data.getMissedAttendanceList(threadID);
  const today = data.getTodayDate();

  let message = `📋 Missed Attendance for ${today}\n\n`;
  
  if (missedList.length === 0) {
    message += "✅ Everyone is present! No one has missed attendance today.";
  } else {
    missedList.forEach((member, index) => {
      const hearts = member.consecutiveAbsences > 0 
        ? ' ' + '💔'.repeat(member.consecutiveAbsences)
        : '';
      const displayName = threadInfo.nicknames?.[member.userID] || member.nickname;
      const nicknameText = threadInfo.nicknames?.[member.userID] ? displayName : `${displayName} (Please apply Gamer Tag/Nick Name)`;
      message += `${index + 1}. ${nicknameText}${hearts}\n\n`;
    });
  }

  console.log("📤 Sending missed attendance report...");
  sendMessage(threadID, message, messageID);
}

async function handleAttendanceResetCommand(threadID, messageID, senderID) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can manually reset attendance!", messageID);
    return;
  }

  console.log("🔄 Admin manually resetting attendance...");
  const success = data.manualResetAttendance(threadID);
  
  if (success) {
    const adminInfo = await getUserInfo(senderID);
    const threadInfo = await getThreadInfo(threadID);
    const adminName = threadInfo?.nicknames?.[senderID] || adminInfo?.name || "Admin";
    
    sendMessage(threadID, `✅ Attendance has been manually reset by ${adminName}.\n\nAll members are now marked as absent. Use .present to mark yourself present.`, messageID);
    console.log(`✅ Attendance reset by ${adminName} (${senderID}) in thread ${threadID}`);
  } else {
    sendMessage(threadID, "❌ Error: Could not reset attendance.", messageID);
  }
}

async function handleResetAttCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can reset consecutive absences!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    }
  }
  
  const adminInfo = await getUserInfo(senderID);
  const threadInfo = await getThreadInfo(threadID);
  const adminName = threadInfo?.nicknames?.[senderID] || adminInfo?.name || "Admin";
  
  if (mentionedUserIDs.length > 0) {
    const targetUserID = mentionedUserIDs[0];
    const userInfo = await getUserInfo(targetUserID);
    const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo?.name || "User";
    
    console.log(`🔄 Admin resetting consecutive absences for ${nickname}...`);
    const success = data.resetConsecutiveAbsences(threadID, targetUserID);
    
    if (success) {
      sendMessage(threadID, `✅ Consecutive absence records have been reset for ${nickname} by ${adminName}.`, messageID);
      console.log(`✅ Consecutive absences reset for ${nickname} by ${adminName} (${senderID}) in thread ${threadID}`);
    } else {
      sendMessage(threadID, "❌ Error: User not found in attendance records.", messageID);
    }
  } else {
    sendMessage(threadID, "❌ Usage: .resetatt @mention\nMention a user to reset their consecutive absence records.\n\nAlternatively, reply to a message with: .resetatt", messageID);
  }
}

async function handleAttendanceExcludeCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can exclude members from attendance!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .attendanceexl @mention\nMention a user to exclude them from attendance.\n\nAlternatively, reply to a message with: .attendanceexl", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  
  if (!userInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo.name;
  const success = data.excludeMember(threadID, targetUserID, nickname);
  
  if (!success) {
    sendMessage(threadID, `❌ ${nickname} is already excluded from attendance.`, messageID);
    return;
  }

  sendMessage(threadID, `✅ ${nickname} has been temporarily excluded from attendance.\n\nThey will not appear in attendance lists or absence lists. Their records are preserved and will be restored when they are brought back.`, messageID);
  console.log(`✅ ${nickname} (${targetUserID}) excluded from attendance in thread ${threadID}`);
}

async function handleAttendanceIncludeCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can include members back into attendance!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .attendanceback @mention\nMention a user to bring them back to attendance.\n\nAlternatively, reply to a message with: .attendanceback", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  const member = data.includeMember(threadID, targetUserID);
  
  if (!member) {
    sendMessage(threadID, "❌ This user is not currently excluded from attendance.", messageID);
    return;
  }

  sendMessage(threadID, `✅ ${member.nickname} has been brought back to attendance.\n\nThey will now appear in attendance lists again with their records restored.`, messageID);
  console.log(`✅ ${member.nickname} (${targetUserID}) brought back to attendance in thread ${threadID}`);
}

async function handleSetGreetingCommand(threadID, messageID, senderID, message) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can modify the greeting!", messageID);
    return;
  }

  let greeting;
  if (message.startsWith(".setgreeting ")) {
    greeting = message.substring(".setgreeting ".length).trim();
  } else if (message.startsWith(".greetings ")) {
    greeting = message.substring(".greetings ".length).trim();
  }
  
  if (!greeting) {
    sendMessage(threadID, "❌ Please provide a greeting message!", messageID);
    return;
  }

  data.setGreeting(threadID, greeting);
  sendMessage(threadID, `✅ Greeting updated!\n\nNew greeting: ${greeting}`, messageID);
}

async function checkMessageSpam(threadID, messageID, senderID, message) {
  if (isProtectedUser(threadID, senderID)) {
    return;
  }

  const key = `spam_${threadID}_${senderID}`;
  const now = Date.now();
  
  if (!spamDetection.has(key)) {
    spamDetection.set(key, { messages: [], lastReset: now, warned: false });
  }

  const userSpam = spamDetection.get(key);
  
  if (now - userSpam.lastReset > 10000) {
    userSpam.messages = [];
    userSpam.lastReset = now;
    userSpam.warned = false;
  }

  userSpam.messages.push(message);

  if (userSpam.messages.length >= 3) {
    const allSame = userSpam.messages.every(msg => msg === userSpam.messages[0]);
    
    if (allSame) {
      if (userSpam.messages.length === 3 && !userSpam.warned) {
        userSpam.warned = true;
        sendMessage(threadID, "⚠️ Warning: You're spamming the same message. If you continue, you will receive a permanent warning!\n\nUse .help to see available commands and avoid consequences.", messageID);
        return false;
      }
      
      if (userSpam.messages.length >= 5 && !userSpam.permanentWarningIssued) {
        userSpam.permanentWarningIssued = true;
        
        const threadInfo = await getThreadInfo(threadID);
        const userInfo = await getUserInfo(senderID);
        const nickname = threadInfo?.nicknames?.[senderID] || userInfo?.name || "User";

        console.log(`⚠️ Permanent warning for ${nickname} for spamming the same message`);
        
        await issueWarning(threadID, messageID, senderID, { body: message }, "Spamming (5 identical messages in 10 seconds)", true);

        spamDetection.delete(key);
        return true;
      }
      
      if (userSpam.messages.length >= 5) {
        return false;
      }
    }
  }

  return false;
}

async function checkMentionWarning(threadID, messageID, senderID, message, event) {
  if (isProtectedUser(threadID, senderID)) {
    return;
  }
  
  const mentions = event.mentions || {};
  
  if (mentions[BOT_USER_ID_TO_DETECT]) {
    const isTensuraMention = message.includes("@TENSURA") || message.toLowerCase().includes("tensura");
    
    if (isTensuraMention) {
      console.log(`✅ User mentioned bot as @TENSURA - allowing without warning`);
      return;
    }
    
    const keywords = data.getWarningKeywords(threadID);
    const normalizedMessage = normalizeForDetection(message);
    
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeForDetection(keyword);
      const flexPattern = createFlexiblePattern(normalizedKeyword);
      
      if (matchFlexibleKeyword(normalizedMessage, normalizedKeyword, flexPattern)) {
        const threadInfo = await getThreadInfo(threadID);
        const userInfo = await getUserInfo(senderID);
        const nickname = threadInfo?.nicknames?.[senderID] || userInfo?.name || "User";
        
        console.log(`⚠️ Warning ${nickname} for mentioning bot with vulgar name containing: ${keyword}`);
        
        await issueWarning(threadID, messageID, senderID, event, `Mentioned bot with vulgar name containing: "${keyword}"`);
        return;
      }
    }
  }
}

async function checkForVulgarWords(threadID, messageID, senderID, message, event) {
  if (data.isWarExtremeMode(threadID)) {
    return;
  }
  
  if (isProtectedUser(threadID, senderID)) {
    return;
  }
  
  const keywords = data.getWarningKeywords(threadID);
  const normalizedMessage = normalizeForDetection(message);
  const normalizedMessageNoSpaces = normalizedMessage.replace(/\s+/g, '');
  const originalWords = extractOriginalWords(message);
  
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForDetection(keyword);
    const flexPattern = createFlexiblePattern(normalizedKeyword);
    
    let matchedInNormal = matchFlexibleKeyword(normalizedMessage, normalizedKeyword, flexPattern);
    let matchedInCompact = matchFlexibleKeyword(normalizedMessageNoSpaces, normalizedKeyword, flexPattern);
    
    if (matchedInNormal || matchedInCompact) {
      let hasActualVulgarWord = originalWords.some(word => {
        const normalizedWord = normalizeForDetection(word);
        return normalizedWord === normalizedKeyword && !isSafeWord(word);
      });
      
      const originalMessageNoSpaces = message.replace(/\s+/g, '');
      const wordsFromCompact = extractOriginalWords(originalMessageNoSpaces);
      let hasActualVulgarWordInCompact = wordsFromCompact.some(word => {
        const normalizedWord = normalizeForDetection(word);
        return normalizedWord === normalizedKeyword && !isSafeWord(word);
      });
      
      let hasOnlySafeWords = originalWords.every(word => isSafeWord(word) || word.length === 0);
      
      if (matchedInCompact && !matchedInNormal) {
        console.log(`🚨 Detected space-bypass attempt: "${message}" → "${normalizedMessageNoSpaces}" matches "${keyword}"`);
        await issueWarning(threadID, messageID, senderID, event, `Used vulgar word (space-bypass detected): "${keyword}"`);
        return;
      }
      
      if (hasOnlySafeWords || (!hasActualVulgarWord && !hasActualVulgarWordInCompact)) {
        console.log(`✓ Skipping false positive: "${message}" matched "${keyword}" but only contains safe words`);
        continue;
      }
      
      await issueWarning(threadID, messageID, senderID, event, `Used vulgar word: "${keyword}"`);
      return;
    }
  }
  
  if (event.messageReply && event.messageReply.body) {
    const isBump = !message || message.trim().length === 0 || message === event.messageReply.body;
    
    if (isBump) {
      const normalizedRepliedMessage = normalizeForDetection(event.messageReply.body);
      const normalizedRepliedMessageNoSpaces = normalizedRepliedMessage.replace(/\s+/g, '');
      
      for (const keyword of keywords) {
        const normalizedKeyword = normalizeForDetection(keyword);
        const flexPattern = createFlexiblePattern(normalizedKeyword);
        
        let matchedInNormal = matchFlexibleKeyword(normalizedRepliedMessage, normalizedKeyword, flexPattern);
        let matchedInCompact = matchFlexibleKeyword(normalizedRepliedMessageNoSpaces, normalizedKeyword, flexPattern);
        
        if (matchedInNormal || matchedInCompact) {
          if (matchedInCompact && !matchedInNormal) {
            console.log(`🚨 Detected space-bypass in bumped message: "${event.messageReply.body}"`);
          }
          await issueWarning(threadID, messageID, senderID, event, `Bumped a message with vulgar word: "${keyword}"`);
          return;
        }
      }
    }
  }
  
  const historyKey = `${threadID}_${senderID}`;
  if (!userMessageHistory.has(historyKey)) {
    userMessageHistory.set(historyKey, []);
  }
  
  const history = userMessageHistory.get(historyKey);
  const currentTimestamp = Date.now();
  history.push({ message: normalizedMessage, originalText: message, timestamp: currentTimestamp });
  
  const recentMessages = history.filter(h => currentTimestamp - h.timestamp < 30000);
  if (history.length > recentMessages.length) {
    userMessageHistory.set(historyKey, recentMessages);
  }
  
  if (recentMessages.length > 1) {
    const combinedMessage = recentMessages.map(h => h.message).join('');
    const combinedMessageNoSpaces = combinedMessage.replace(/\s+/g, '');
    const combinedOriginalText = recentMessages.map(h => h.originalText).join(' ');
    
    for (const keyword of keywords) {
      const normalizedKeyword = normalizeForDetection(keyword);
      const flexPattern = createFlexiblePattern(normalizedKeyword);
      
      let matchedInNormal = matchFlexibleKeyword(combinedMessage, normalizedKeyword, flexPattern);
      let matchedInCompact = matchFlexibleKeyword(combinedMessageNoSpaces, normalizedKeyword, flexPattern);
      
      if (matchedInNormal || matchedInCompact) {
        if (matchedInCompact && !matchedInNormal) {
          console.log(`🚨 Detected space-bypass across messages: "${combinedOriginalText.substring(0, 50)}..."`);
        }
        await issueWarning(threadID, messageID, senderID, event, `Used vulgar word across multiple messages: "${keyword}" (Combined: "${combinedOriginalText.substring(0, 50)}...")`);
        userMessageHistory.delete(historyKey);
        return;
      }
    }
  }
  
  if (recentMessages.length > 10) {
    recentMessages.shift();
    userMessageHistory.set(historyKey, recentMessages);
  }
}

const COMMON_SAFE_WORDS = new Set([
  'a', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'of', 'ok', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
  'all', 'and', 'are', 'but', 'can', 'did', 'for', 'get', 'had', 'has', 'her', 'him', 'his', 'how', 'its', 'may', 'new', 'not', 'now', 'off', 'old', 'one', 'our', 'out', 'own', 'put', 'run', 'say', 'see', 'set', 'she', 'the', 'too', 'two', 'use', 'was', 'way', 'who', 'why', 'will', 'with', 'you', 'your'
]);

const MIN_KEYWORD_LENGTH = 3;

function validateKeyword(keyword) {
  const normalized = normalizeForDetection(keyword);
  
  if (normalized.length < MIN_KEYWORD_LENGTH) {
    return {
      valid: false,
      reason: `too short (minimum ${MIN_KEYWORD_LENGTH} characters after normalization)`
    };
  }
  
  const words = normalized.split(/\s+/);
  const isSingleCommonWord = words.length === 1 && COMMON_SAFE_WORDS.has(words[0]);
  
  if (isSingleCommonWord) {
    return {
      valid: false,
      reason: 'common English word that would cause false positives'
    };
  }
  
  return { valid: true };
}

function normalizeFancyUnicode(text) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    let normalized = null;
    
    if (code >= 0x24B6 && code <= 0x24CF) normalized = String.fromCharCode(code - 0x24B6 + 0x41);
    else if (code >= 0x24D0 && code <= 0x24E9) normalized = String.fromCharCode(code - 0x24D0 + 0x61);
    else if (code >= 0xFF21 && code <= 0xFF3A) normalized = String.fromCharCode(code - 0xFF21 + 0x41);
    else if (code >= 0xFF41 && code <= 0xFF5A) normalized = String.fromCharCode(code - 0xFF41 + 0x61);
    else if (code >= 0x1D400 && code <= 0x1D419) normalized = String.fromCharCode(code - 0x1D400 + 0x41);
    else if (code >= 0x1D41A && code <= 0x1D433) normalized = String.fromCharCode(code - 0x1D41A + 0x61);
    else if (code >= 0x1D434 && code <= 0x1D44D) normalized = String.fromCharCode(code - 0x1D434 + 0x41);
    else if (code >= 0x1D44E && code <= 0x1D467) normalized = String.fromCharCode(code - 0x1D44E + 0x61);
    else if (code >= 0x1D468 && code <= 0x1D481) normalized = String.fromCharCode(code - 0x1D468 + 0x41);
    else if (code >= 0x1D482 && code <= 0x1D49B) normalized = String.fromCharCode(code - 0x1D482 + 0x61);
    else if (code >= 0x1D49C && code <= 0x1D4B5) normalized = String.fromCharCode(code - 0x1D49C + 0x41);
    else if (code >= 0x1D4B6 && code <= 0x1D4CF) normalized = String.fromCharCode(code - 0x1D4B6 + 0x61);
    else if (code >= 0x1D4D0 && code <= 0x1D4E9) normalized = String.fromCharCode(code - 0x1D4D0 + 0x41);
    else if (code >= 0x1D4EA && code <= 0x1D503) normalized = String.fromCharCode(code - 0x1D4EA + 0x61);
    else if (code >= 0x1D504 && code <= 0x1D51D) normalized = String.fromCharCode(code - 0x1D504 + 0x41);
    else if (code >= 0x1D51E && code <= 0x1D537) normalized = String.fromCharCode(code - 0x1D51E + 0x61);
    else if (code >= 0x1D538 && code <= 0x1D551) normalized = String.fromCharCode(code - 0x1D538 + 0x41);
    else if (code >= 0x1D552 && code <= 0x1D56B) normalized = String.fromCharCode(code - 0x1D552 + 0x61);
    else if (code >= 0x1D56C && code <= 0x1D585) normalized = String.fromCharCode(code - 0x1D56C + 0x41);
    else if (code >= 0x1D586 && code <= 0x1D59F) normalized = String.fromCharCode(code - 0x1D586 + 0x61);
    else if (code >= 0x1D5A0 && code <= 0x1D5B9) normalized = String.fromCharCode(code - 0x1D5A0 + 0x41);
    else if (code >= 0x1D5BA && code <= 0x1D5D3) normalized = String.fromCharCode(code - 0x1D5BA + 0x61);
    else if (code >= 0x1D5D4 && code <= 0x1D5ED) normalized = String.fromCharCode(code - 0x1D5D4 + 0x41);
    else if (code >= 0x1D5EE && code <= 0x1D607) normalized = String.fromCharCode(code - 0x1D5EE + 0x61);
    else if (code >= 0x1D608 && code <= 0x1D621) normalized = String.fromCharCode(code - 0x1D608 + 0x41);
    else if (code >= 0x1D622 && code <= 0x1D63B) normalized = String.fromCharCode(code - 0x1D622 + 0x61);
    else if (code >= 0x1D63C && code <= 0x1D655) normalized = String.fromCharCode(code - 0x1D63C + 0x41);
    else if (code >= 0x1D656 && code <= 0x1D66F) normalized = String.fromCharCode(code - 0x1D656 + 0x61);
    else if (code >= 0x1D670 && code <= 0x1D689) normalized = String.fromCharCode(code - 0x1D670 + 0x41);
    else if (code >= 0x1D68A && code <= 0x1D6A3) normalized = String.fromCharCode(code - 0x1D68A + 0x61);
    else if (code >= 0x1D6A4 && code <= 0x1D6A5) normalized = String.fromCharCode(code - 0x1D6A4 + 0x49);
    else if (code >= 0x1D6A8 && code <= 0x1D6C0) normalized = String.fromCharCode(code - 0x1D6A8 + 0x41);
    else if (code >= 0x1D6C2 && code <= 0x1D6DA) normalized = String.fromCharCode(code - 0x1D6C2 + 0x61);
    else if (code >= 0x1D6DC && code <= 0x1D6E1) normalized = String.fromCharCode(code - 0x1D6DC + 0x61);
    else if (code >= 0x1D6E2 && code <= 0x1D6FA) normalized = String.fromCharCode(code - 0x1D6E2 + 0x41);
    else if (code >= 0x1D6FC && code <= 0x1D714) normalized = String.fromCharCode(code - 0x1D6FC + 0x61);
    else if (code >= 0x1D716 && code <= 0x1D71B) normalized = String.fromCharCode(code - 0x1D716 + 0x61);
    else if (code >= 0x1D71C && code <= 0x1D734) normalized = String.fromCharCode(code - 0x1D71C + 0x41);
    else if (code >= 0x1D736 && code <= 0x1D74E) normalized = String.fromCharCode(code - 0x1D736 + 0x61);
    else if (code >= 0x1D750 && code <= 0x1D755) normalized = String.fromCharCode(code - 0x1D750 + 0x61);
    else if (code >= 0x1D756 && code <= 0x1D76E) normalized = String.fromCharCode(code - 0x1D756 + 0x41);
    else if (code >= 0x1D770 && code <= 0x1D788) normalized = String.fromCharCode(code - 0x1D770 + 0x61);
    else if (code >= 0x1D78A && code <= 0x1D78F) normalized = String.fromCharCode(code - 0x1D78A + 0x61);
    else if (code >= 0x1D790 && code <= 0x1D7A8) normalized = String.fromCharCode(code - 0x1D790 + 0x41);
    else if (code >= 0x1D7AA && code <= 0x1D7C2) normalized = String.fromCharCode(code - 0x1D7AA + 0x61);
    else if (code >= 0x1D7C4 && code <= 0x1D7C9) normalized = String.fromCharCode(code - 0x1D7C4 + 0x61);
    else {
      const lookalikes = {
        'Α':'a','Β':'b','Ε':'e','Ζ':'z','Η':'h','Ι':'i','Κ':'k','Μ':'m','Ν':'n','Ο':'o','Ρ':'p','Τ':'t','Υ':'y','Χ':'x','Γ':'g','Δ':'d','Θ':'t','Λ':'l','Ξ':'x','Π':'p','Σ':'s','Φ':'f','Ψ':'p','Ω':'w',
        'α':'a','β':'b','γ':'g','δ':'d','ε':'e','ζ':'z','η':'h','θ':'t','ι':'i','κ':'k','λ':'l','μ':'m','ν':'n','ξ':'x','ο':'o','π':'p','ρ':'r','σ':'s','ς':'s','τ':'t','υ':'y','φ':'f','χ':'x','ψ':'p','ω':'w',
        'А':'a','В':'b','Е':'e','К':'k','М':'m','Н':'h','О':'o','Р':'p','С':'c','Т':'t','У':'y','Х':'x','Ѕ':'s','І':'i','Ј':'j','Ґ':'g','Ғ':'f','Ҝ':'k','Ӏ':'i','Ӧ':'o','Ӱ':'y',
        'а':'a','в':'b','е':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x','ѕ':'s','і':'i','ј':'j','ԁ':'d','ԍ':'g','ԛ':'q','ԝ':'w','ҝ':'k','ӏ':'i','ӧ':'o','ӱ':'y',
        'Ꝋ':'o','ꝋ':'o','Ᏽ':'g','ℊ':'g','ℎ':'h','ℏ':'h','ℓ':'l','ℯ':'e','ℴ':'o','ℹ':'i','ℼ':'p','ℽ':'p','ℾ':'p','ℿ':'p','ⅅ':'d','ⅆ':'d','ⅇ':'e','ⅈ':'i','ⅉ':'j','ℂ':'c','ℍ':'h','ℕ':'n','ℙ':'p','ℚ':'q','ℝ':'r','ℤ':'z',
        'Ⰰ':'a','Ⰱ':'b','Ⰲ':'v','Ⰳ':'g','Ⰴ':'d','Ⰵ':'e','Ⰶ':'z','Ⰸ':'i','Ⰹ':'i','Ⰺ':'j','Ⰻ':'k','Ⰼ':'l','Ⰽ':'m','Ⰾ':'n','Ⰿ':'o','Ⱀ':'p','Ⱁ':'r','Ⱂ':'s','Ⱃ':'t','Ⱄ':'u',
        '𐌀':'a','𐌁':'b','𐌂':'c','𐌃':'d','𐌄':'e','𐌅':'f','𐌆':'z','𐌇':'h','𐌈':'i','𐌉':'i','𐌊':'k','𐌋':'l','𐌌':'m','𐌍':'n','𐌏':'o','𐌐':'p','𐌑':'q','𐌒':'r','𐌓':'s','𐌔':'t','𐌕':'t','𐌖':'v','𐌗':'x','𐌵':'u',
        'Ａ':'a','Ｂ':'b','Ｃ':'c','Ｄ':'d','Ｅ':'e','Ｆ':'f','Ｇ':'g','Ｈ':'h','Ｉ':'i','Ｊ':'j','Ｋ':'k','Ｌ':'l','Ｍ':'m','Ｎ':'n','Ｏ':'o','Ｐ':'p','Ｑ':'q','Ｒ':'r','Ｓ':'s','Ｔ':'t','Ｕ':'u','Ｖ':'v','Ｗ':'w','Ｘ':'x','Ｙ':'y','Ｚ':'z',
        'ａ':'a','ｂ':'b','ｃ':'c','ｄ':'d','ｅ':'e','ｆ':'f','ｇ':'g','ｈ':'h','ｉ':'i','ｊ':'j','ｋ':'k','ｌ':'l','ｍ':'m','ｎ':'n','ｏ':'o','ｐ':'p','ｑ':'q','ｒ':'r','ｓ':'s','ｔ':'t','ｕ':'u','ｖ':'v','ｗ':'w','ｘ':'x','ｙ':'y','ｚ':'z',
        '⒜':'a','⒝':'b','⒞':'c','⒟':'d','⒠':'e','⒡':'f','⒢':'g','⒣':'h','⒤':'i','⒥':'j','⒦':'k','⒧':'l','⒨':'m','⒩':'n','⒪':'o','⒫':'p','⒬':'q','⒭':'r','⒮':'s','⒯':'t','⒰':'u','⒱':'v','⒲':'w','⒳':'x','⒴':'y','⒵':'z',
        'Ⓐ':'a','Ⓑ':'b','Ⓒ':'c','Ⓓ':'d','Ⓔ':'e','Ⓕ':'f','Ⓖ':'g','Ⓗ':'h','Ⓘ':'i','Ⓙ':'j','Ⓚ':'k','Ⓛ':'l','Ⓜ':'m','Ⓝ':'n','Ⓞ':'o','Ⓟ':'p','Ⓠ':'q','Ⓡ':'r','Ⓢ':'s','Ⓣ':'t','Ⓤ':'u','Ⓥ':'v','Ⓦ':'w','Ⓧ':'x','Ⓨ':'y','Ⓩ':'z',
        'ⓐ':'a','ⓑ':'b','ⓒ':'c','ⓓ':'d','ⓔ':'e','ⓕ':'f','ⓖ':'g','ⓗ':'h','ⓘ':'i','ⓙ':'j','ⓚ':'k','ⓛ':'l','ⓜ':'m','ⓝ':'n','ⓞ':'o','ⓟ':'p','ⓠ':'q','ⓡ':'r','ⓢ':'s','ⓣ':'t','ⓤ':'u','ⓥ':'v','ⓦ':'w','ⓧ':'x','ⓨ':'y','ⓩ':'z',
        '🅐':'a','🅑':'b','🅒':'c','🅓':'d','🅔':'e','🅕':'f','🅖':'g','🅗':'h','🅘':'i','🅙':'j','🅚':'k','🅛':'l','🅜':'m','🅝':'n','🅞':'o','🅟':'p','🅠':'q','🅡':'r','🅢':'s','🅣':'t','🅤':'u','🅥':'v','🅦':'w','🅧':'x','🅨':'y','🅩':'z',
        '🅰':'a','🅱':'b','🅲':'c','🅳':'d','🅴':'e','🅵':'f','🅶':'g','🅷':'h','🅸':'i','🅹':'j','🅺':'k','🅻':'l','🅼':'m','🅽':'n','🅾':'o','🅿':'p','🆀':'q','🆁':'r','🆂':'s','🆃':'t','🆄':'u','🆅':'v','🆆':'w','🆇':'x','🆈':'y','🆉':'z',
        '𝐀':'a','𝐁':'b','𝐂':'c','𝐃':'d','𝐄':'e','𝐅':'f','𝐆':'g','𝐇':'h','𝐈':'i','𝐉':'j','𝐊':'k','𝐋':'l','𝐌':'m','𝐍':'n','𝐎':'o','𝐏':'p','𝐐':'q','𝐑':'r','𝐒':'s','𝐓':'t','𝐔':'u','𝐕':'v','𝐖':'w','𝐗':'x','𝐘':'y','𝐙':'z',
        '𝐚':'a','𝐛':'b','𝐜':'c','𝐝':'d','𝐞':'e','𝐟':'f','𝐠':'g','𝐡':'h','𝐢':'i','𝐣':'j','𝐤':'k','𝐥':'l','𝐦':'m','𝐧':'n','𝐨':'o','𝐩':'p','𝐪':'q','𝐫':'r','𝐬':'s','𝐭':'t','𝐮':'u','𝐯':'v','𝐰':'w','𝐱':'x','𝐲':'y','𝐳':'z',
        'ᵃ':'a','ᵇ':'b','ᶜ':'c','ᵈ':'d','ᵉ':'e','ᶠ':'f','ᵍ':'g','ʰ':'h','ⁱ':'i','ʲ':'j','ᵏ':'k','ˡ':'l','ᵐ':'m','ⁿ':'n','ᵒ':'o','ᵖ':'p','ʳ':'r','ˢ':'s','ᵗ':'t','ᵘ':'u','ᵛ':'v','ʷ':'w','ˣ':'x','ʸ':'y','ᶻ':'z',
        'ₐ':'a','ₑ':'e','ₕ':'h','ᵢ':'i','ⱼ':'j','ₖ':'k','ₗ':'l','ₘ':'m','ₙ':'n','ₒ':'o','ₚ':'p','ᵣ':'r','ₛ':'s','ₜ':'t','ᵤ':'u','ᵥ':'v','ₓ':'x',
        '🇦':'a','🇧':'b','🇨':'c','🇩':'d','🇪':'e','🇫':'f','🇬':'g','🇭':'h','🇮':'i','🇯':'j','🇰':'k','🇱':'l','🇲':'m','🇳':'n','🇴':'o','🇵':'p','🇶':'q','🇷':'r','🇸':'s','🇹':'t','🇺':'u','🇻':'v','🇼':'w','🇽':'x','🇾':'y','🇿':'z',
        '♠':'s','♣':'c','♥':'h','♦':'d','★':'s','☆':'s','▪':'i','●':'o','○':'o','◉':'o','◐':'o','◑':'o','◒':'o','◓':'o','◔':'o','◕':'o','◖':'o','◗':'o',
        '〇':'o','㊀':'zero','㊁':'one','㊂':'two','㊃':'three','㊄':'four','㊅':'five','㊆':'six','㊇':'seven','㊈':'eight','㊉':'nine'
      };
      const char = String.fromCodePoint(code);
      normalized = lookalikes[char] || char;
    }
    
    result += normalized;
    if (code > 0xFFFF) i++;
  }
  return result;
}

const SAFE_WORDS = [
  'click', 'clicks', 'clicked', 'clicking', 'clicker',
  'clock', 'clocks',
  'back', 'backs', 'backed', 'backing',
  'bucket', 'buckets',
  'duck', 'ducks',
  'luck', 'lucky', 'luckily',
  'suck', 'sucks', 'sucker',
  'truck', 'trucks',
  'stuck',
  'sit', 'sits', 'sitting'
];

function isSafeWord(word) {
  const cleanWord = word.toLowerCase().trim().replace(/[^a-z]/gi, '');
  
  if (COMMON_SAFE_WORDS.has(cleanWord)) {
    return true;
  }
  
  return SAFE_WORDS.some(safeWord => {
    return cleanWord === safeWord || 
           cleanWord === safeWord + 's' ||
           cleanWord === safeWord + 'ed' ||
           cleanWord === safeWord + 'ing' ||
           cleanWord === safeWord + 'er';
  });
}

function extractOriginalWords(message) {
  return message.toLowerCase().trim().split(/\s+/).map(word => word.replace(/[^a-z]/gi, ''));
}

function normalizeForDetection(text) {
  let normalized = normalizeFancyUnicode(text).toLowerCase();
  
  normalized = normalized
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2060-\u206F]/g, '')
    .replace(/[\uFE00-\uFE0F]/g, '')
    .replace(/[\u202A-\u202E]/g, '');
  
  for (let pass = 0; pass < 7; pass++) {
    normalized = normalized
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u0100-\u017f]/g, (char) => {
        const map = {
          'ā':'a','ă':'a','ą':'a','ǎ':'a','ǻ':'a','à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a',
          'ē':'e','ĕ':'e','ė':'e','ę':'e','ě':'e','è':'e','é':'e','ê':'e','ë':'e',
          'ī':'i','ĭ':'i','į':'i','ı':'i','ì':'i','í':'i','î':'i','ï':'i','ĩ':'i',
          'ō':'o','ŏ':'o','ő':'o','ǒ':'o','ǿ':'o','ø':'o','ò':'o','ó':'o','ô':'o','õ':'o','ö':'o',
          'ū':'u','ŭ':'u','ů':'u','ű':'u','ų':'u','ù':'u','ú':'u','û':'u','ü':'u','ũ':'u',
          'ñ':'n','ń':'n','ņ':'n','ň':'n','ŋ':'n',
          'ç':'c','ć':'c','ĉ':'c','ċ':'c','č':'c',
          'ś':'s','ŝ':'s','ş':'s','š':'s',
          'ý':'y','ÿ':'y','ŷ':'y',
          'ğ':'g','ĝ':'g','ģ':'g'
        };
        return map[char] || char;
      })
      .replace(/[øØ∅⊘⊗⌀]/g, 'o')
      .replace(/[àáâãäåæāăąǎǻ]/g, 'a')
      .replace(/[èéêëēĕėęě]/g, 'e')
      .replace(/[ìíîïĩīĭįı]/g, 'i')
      .replace(/[òóôõöøōŏőǒǿ]/g, 'o')
      .replace(/[ùúûüũūŭůűų]/g, 'u')
      .replace(/[ñńņňŋ]/g, 'n')
      .replace(/[çćĉċč]/g, 'c')
      .replace(/[śŝşš]/g, 's')
      .replace(/[ýÿŷ]/g, 'y')
      .replace(/[ğĝģ]/g, 'g')
      .replace(/[żźž]/g, 'z')
      .replace(/[ðþ]/g, 'd')
      .replace(/[ß]/g, 's')
      .replace(/[æ]/g, 'a')
      .replace(/[œ]/g, 'o')
      .replace(/[@]/g, 'a')
      .replace(/[&]/g, 'a')
      .replace(/[₳Ⱥ]/g, 'a')
      .replace(/[₿฿]/g, 'b')
      .replace(/[¢₡₵₢]/g, 'c')
      .replace(/[₫ⅅ]/g, 'd')
      .replace(/[€₤£₠]/g, 'e')
      .replace(/[₣]/g, 'f')
      .replace(/[₲]/g, 'g')
      .replace(/[₴]/g, 'h')
      .replace(/[₱₧]/g, 'p')
      .replace(/[₹₨]/g, 'r')
      .replace(/[$₴₷]/g, 's')
      .replace(/[₮₸]/g, 't')
      .replace(/[₦]/g, 'n')
      .replace(/[₩]/g, 'w')
      .replace(/[¥₺]/g, 'y')
      .replace(/[₵]/g, 'z')
      .replace(/[!¡|]/g, 'i')
      .replace(/[\/\\]/g, '')
      .replace(/[×∗∘⊗⊕]/g, 'x')
      .replace(/[#]/g, 'h')
      .replace(/[%‰]/g, 'o')
      .replace(/[+]/g, 't')
      .replace(/[~≈]/g, 'n')
      .replace(/[*]/g, '')
      .replace(/[°ᵒ]/g, 'o')
      .replace(/[¹]/g, 'i')
      .replace(/[²]/g, 'z')
      .replace(/[³]/g, 'e')
      .replace(/[⁴]/g, 'a')
      .replace(/[⁵]/g, 's')
      .replace(/[⁶]/g, 'g')
      .replace(/[⁷]/g, 't')
      .replace(/[⁸]/g, 'b')
      .replace(/[⁹]/g, 'g')
      .replace(/[⁰]/g, 'o')
      .replace(/[₀]/g, 'o')
      .replace(/[₁]/g, 'i')
      .replace(/[₂]/g, 'z')
      .replace(/[₃]/g, 'e')
      .replace(/[₄]/g, 'a')
      .replace(/[₅]/g, 's')
      .replace(/[₆]/g, 'g')
      .replace(/[₇]/g, 't')
      .replace(/[₈]/g, 'b')
      .replace(/[₉]/g, 'g')
      .replace(/[.,:;'"<>?{}[\]()]/g, '')
      .replace(/ph/g, 'f')
      .replace(/ck/g, 'k')
      .replace(/qu/g, 'kw')
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/2/g, 'z')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/6/g, 'g')
      .replace(/7/g, 't')
      .replace(/8/g, 'b')
      .replace(/9/g, 'g')
      .replace(/[-_]/g, '')
      .replace(/[^a-z\s]/g, '')
      .replace(/(.)\1\1\1+/g, '$1$1')
      .replace(/(.)\1\1+/g, '$1')
      .replace(/(.)\1+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  normalized = applyKeyboardProximity(normalized);
  normalized = expandAbbreviations(normalized);
  normalized = applyPhoneticReplacements(normalized);
  
  return normalized;
}

function applyKeyboardProximity(text) {
  const proximityMap = {
    'w':'vv','vv':'w','rn':'m','m':'rn','cl':'d','d':'cl',
    'ii':'u','nn':'m','uu':'w'
  };
  let result = text;
  for (const [pattern, replacement] of Object.entries(proximityMap)) {
    result = result.replace(new RegExp(pattern, 'g'), replacement);
  }
  return result;
}

function applyPhoneticReplacements(text) {
  return text
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/ks/g, 'x')
    .replace(/qu/g, 'kw')
    .replace(/kn/g, 'n')
    .replace(/wr/g, 'r')
    .replace(/gh/g, 'g')
    .replace(/ps/g, 's')
    .replace(/pn/g, 'n')
    .replace(/pt/g, 't')
    .replace(/tch/g, 'ch')
    .replace(/dge/g, 'j')
    .replace(/xc/g, 'ks')
    .replace(/sc/g, 's')
    .replace(/sh/g, 's')
    .replace(/th/g, 't')
    .replace(/wh/g, 'w')
    .replace(/v/g, 'f')
    .replace(/w/g, 'v')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k');
}

function expandAbbreviations(text) {
  const words = text.split(/\s+/);
  const expanded = words.map(word => {
    switch(word) {
      case 'tt': return 'tite';
      case 'pp': return 'pepe';
      case 'tn': return 'tanginamo';
      case 'tg': return 'tangina';
      case 'gg': return 'gago';
      case 'pt': return 'puta';
      case 'bs': return 'bobo';
      case 'ts': return 'tarantado';
      default: return word;
    }
  });
  return expanded.join(' ');
}

function createFlexiblePattern(normalizedKeyword) {
  const chars = normalizedKeyword.split('');
  const letterCount = chars.filter(c => /[a-z]/.test(c)).length;
  
  const pattern = chars.map(char => {
    if (char === ' ') {
      return '\\s+';
    } else if (/[a-z]/.test(char)) {
      return char + '[^a-z]*';
    } else {
      return escapeRegex(char);
    }
  }).join('');
  
  const finalPattern = `(?:^|\\s)(${pattern.replace(/\[\^a-z\]\*$/, '')})(?:\\s|$)`;
  const regex = new RegExp(finalPattern, 'i');
  
  regex.expectedLetterCount = letterCount;
  return regex;
}

function matchFlexibleKeyword(text, normalizedKeyword, flexPattern) {
  const match = text.match(flexPattern);
  if (!match) {
    return false;
  }
  
  const matchedText = match[1] || match[0];
  const matchedLetters = (matchedText.match(/[a-zA-Z]/g) || []).length;
  const expectedLetters = flexPattern.expectedLetterCount;
  
  if (matchedLetters !== expectedLetters) {
    console.log(`✓ Skipping length mismatch: matched "${matchedText}" (${matchedLetters} letters) vs keyword (${expectedLetters} letters)`);
    return false;
  }
  
  return true;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function issueWarning(threadID, messageID, senderID, event, reason, isPermanent = false) {
  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) return;
  
  const userInfo = await getUserInfo(senderID);
  if (!userInfo) return;
  
  const nickname = threadInfo.nicknames?.[senderID] || userInfo.name;
  const warningCount = data.addWarning(threadID, senderID, nickname, reason, messageID, isPermanent);
  
  if (isPermanent) {
    sendMessage(threadID, `🔒 ${nickname} has received a PERMANENT warning!\n\nReason: ${reason}\n\n⚠️ This warning cannot be removed!`, messageID);
    return;
  }
  
  const warningSymbols = "⛔".repeat(warningCount);
  
  if (warningCount >= 3) {
    const banReason = `Accumulated 3 warnings`;
    const uid = data.banMember(threadID, senderID, nickname, banReason, "System");
    data.clearWarnings(threadID, senderID);
    
    sendMessage(threadID, `⚠️ ${nickname} has been warned!\n\nReason: ${reason}\nWarnings: ${warningSymbols}\n\n❌ User has reached 3 warnings and will be kicked!`, messageID);
    
    setTimeout(() => {
      sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
      
      setTimeout(() => {
        api.removeUserFromGroup(senderID, threadID, (err) => {
          if (err) {
            console.error("Failed to remove user from group:", err);
            sendMessage(threadID, `❌ Failed to kick ${nickname}. Please try again or remove manually.`, messageID);
          } else {
            console.log(`✅ Kicked ${nickname} for 3 warnings`);
          }
        });
      }, 1000);
    }, 1000);
  } else {
    sendMessage(threadID, `⚠️ ${nickname} has been warned!\n\nReason: ${reason}\nWarnings: ${warningSymbols}\n\n⚠️ Warning: You will be kicked at 3 warnings!`, messageID);
  }
}

async function handleAddWarningKeywordCommand(threadID, messageID, senderID, message) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can add warning keywords!", messageID);
    return;
  }

  const keywordsText = message.substring(".addwarning ".length).trim();
  
  if (!keywordsText) {
    sendMessage(threadID, "❌ Usage: .addwarning [word1, word2, ...]\nExample: .addwarning fuck, shit, bitch", messageID);
    return;
  }

  const keywords = keywordsText.split(',').map(k => k.trim()).filter(k => k.length > 0);
  
  if (keywords.length === 0) {
    sendMessage(threadID, "❌ No valid keywords provided!", messageID);
    return;
  }

  const validKeywords = [];
  const invalidKeywords = [];
  
  for (const keyword of keywords) {
    const validation = validateKeyword(keyword);
    if (validation.valid) {
      validKeywords.push(keyword);
    } else {
      invalidKeywords.push({ word: keyword, reason: validation.reason });
    }
  }

  let responseMessage = "";
  
  if (validKeywords.length > 0) {
    const result = data.addWarningKeywords(threadID, validKeywords);
    
    if (result.added.length > 0) {
      responseMessage += `✅ Warning keywords added: ${result.added.join(', ')}\n\n`;
    }
    
    if (result.skipped.length > 0) {
      responseMessage += `⚠️ Already in list: ${result.skipped.join(', ')}\n\n`;
    }
  }
  
  if (invalidKeywords.length > 0) {
    responseMessage += `❌ Rejected keywords:\n`;
    for (const item of invalidKeywords) {
      responseMessage += `  • "${item.word}" - ${item.reason}\n`;
    }
    responseMessage += "\n";
  }
  
  if (validKeywords.length > 0 && invalidKeywords.length === 0) {
    responseMessage += "These words will now trigger automatic warnings.";
  }
  
  sendMessage(threadID, responseMessage.trim(), messageID);
}

async function handleRemoveWarningKeywordCommand(threadID, messageID, senderID, message) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can remove warning keywords!", messageID);
    return;
  }

  const keywordsText = message.substring(".removeword ".length).trim();
  
  if (!keywordsText) {
    sendMessage(threadID, "❌ Usage: .removeword [word1, word2, ...]\nExample: .removeword fuck, shit, bitch", messageID);
    return;
  }

  const keywords = keywordsText.split(',').map(k => k.trim()).filter(k => k.length > 0);
  
  if (keywords.length === 0) {
    sendMessage(threadID, "❌ No valid keywords provided!", messageID);
    return;
  }

  const result = data.removeWarningKeywords(threadID, keywords);
  
  let responseMessage = "";
  
  if (result.removed.length > 0) {
    responseMessage += `✅ Warning keywords removed: ${result.removed.join(', ')}\n\n`;
  }
  
  if (result.notFound.length > 0) {
    responseMessage += `⚠️ Not found in list: ${result.notFound.join(', ')}\n\n`;
  }
  
  if (result.removed.length > 0) {
    responseMessage += "These words will no longer trigger automatic warnings.";
  }
  
  sendMessage(threadID, responseMessage.trim(), messageID);
}

async function handleManualWarningCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can manually warn users!", messageID);
    return;
  }

  console.log("🔍 DEBUG - Event object for .warning command:", JSON.stringify({
    mentions: event.mentions,
    body: event.body,
    messageReply: event.messageReply,
    participantIDs: event.participantIDs
  }, null, 2));

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    console.log("⚠️ No mentions found in event.mentions, checking messageReply...");
    
    if (event.messageReply && event.messageReply.senderID) {
      console.log("✅ Found user ID in messageReply:", event.messageReply.senderID);
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      console.log("❌ No mentions or reply found");
      sendMessage(threadID, "❌ Usage: .warning @mention [reason]\nExample: .warning @user spamming\n\nAlternatively, reply to a message with: .warning [reason]", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  
  if (isProtectedUser(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot warn the developer or super admin!", messageID);
    return;
  }
  
  const targetIsAdmin = isAdmin(threadID, targetUserID);
  const senderIsProtected = isProtectedUser(threadID, senderID);
  
  if (targetIsAdmin && !senderIsProtected) {
    sendMessage(threadID, "❌ Only the Developer and Super Admin can warn other admins!", messageID);
    return;
  }

  const message = event.body;
  const args = message.substring(".warning ".length).trim();
  const mentionName = mentions[targetUserID] || "";
  const reason = args.replace(mentionName, "").trim() || "Manual warning by admin";
  
  const isPermanentWarning = targetIsAdmin && senderIsProtected;
  
  if (isPermanentWarning) {
    console.log("🔒 Issuing PERMANENT warning to admin:", targetUserID, "Reason:", reason);
  } else {
    console.log("✅ Issuing warning to:", targetUserID, "Reason:", reason);
  }
  
  await issueWarning(threadID, messageID, targetUserID, event, reason, isPermanentWarning);
}

async function handleUnwarningCommand(threadID, messageID, senderID, event) {
  const message = event.body.trim();
  const isSelfUnwarning = message.toLowerCase() === '.unwarning me';
  
  if (isSelfUnwarning) {
    if (!isAdmin(threadID, senderID)) {
      sendMessage(threadID, "❌ Only admins can use the .unwarning command!", messageID);
      return;
    }
    
    const currentCount = data.getWarningCount(threadID, senderID);
    
    if (currentCount === 0) {
      sendMessage(threadID, "❌ You have no warnings to remove!", messageID);
      return;
    }
    
    const oldCount = currentCount;
    const newCount = data.deductWarning(threadID, senderID);
    const threadInfo = await getThreadInfo(threadID);
    const userInfo = await getUserInfo(senderID);
    const nickname = threadInfo?.nicknames?.[senderID] || userInfo?.name || "User";
    
    if (oldCount === newCount) {
      sendMessage(threadID, `🔒 ${nickname} has permanent warnings that cannot be removed!`, messageID);
      return;
    }
    
    const warningSymbols = newCount > 0 ? "⛔".repeat(newCount) : "✅ Clean";
    
    sendMessage(threadID, `✅ Warning removed for ${nickname}!\n\nRemaining warnings: ${warningSymbols}`, messageID);
    return;
  }
  
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can remove warnings!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .unwarning @mention\nMention a user to remove one warning.\n\nAlternatively, reply to a message with: .unwarning\n\n💡 Tip: Use '.unwarning me' to remove your own warning.", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  const currentCount = data.getWarningCount(threadID, targetUserID);
  
  if (currentCount === 0) {
    sendMessage(threadID, "❌ This user has no warnings to remove!", messageID);
    return;
  }

  const canRemovePermanent = isProtectedUser(threadID, senderID);
  const oldCount = currentCount;
  const newCount = data.deductWarning(threadID, targetUserID, canRemovePermanent);
  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo?.name || "User";
  
  if (oldCount === newCount && !canRemovePermanent) {
    sendMessage(threadID, `🔒 ${nickname} has permanent warnings that cannot be removed!\n\n⚠️ Only the Developer or Super Admin can remove permanent warnings.`, messageID);
    return;
  }
  
  const warningSymbols = newCount > 0 ? "⛔".repeat(newCount) : "✅ Clean";
  
  sendMessage(threadID, `✅ Warning removed for ${nickname}!\n\nRemaining warnings: ${warningSymbols}`, messageID);
}

async function handleWarningListCommand(threadID, messageID) {
  const warnings = data.getAllWarnings(threadID);
  
  if (warnings.length === 0) {
    sendMessage(threadID, "✅ No warnings in this group!", messageID);
    return;
  }

  let message = "⚠️ Warning List\n\n";
  
  warnings.forEach((warning, index) => {
    const warningSymbols = "⛔".repeat(warning.count);
    message += `${index + 1}. ${warning.nickname} - ${warningSymbols}\n`;
    
    if (warning.reasons && warning.reasons.length > 0) {
      message += "   Reasons:\n";
      warning.reasons.forEach((reasonData, idx) => {
        const date = new Date(reasonData.date).toLocaleDateString();
        const key = reasonData.key ? ` [${reasonData.key}]` : "";
        message += `   ${idx + 1}. ${reasonData.reason}${key} (${date})\n`;
      });
    }
    message += "\n";
  });
  
  message += `📊 Total: ${warnings.length} user(s) with warnings`;
  
  sendMessage(threadID, message, messageID);
}

async function handleBanCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can ban members!", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) {
    sendMessage(threadID, "❌ Error: Could not retrieve group information.", messageID);
    return;
  }

  const message = event.body;
  const args = message.substring(".ban ".length).trim();
  
  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .ban @mention [reason]\nMention a user to ban them.\n\nAlternatively, reply to a message with: .ban [reason]", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  
  if (isProtectedUser(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot ban the developer or super admin!", messageID);
    return;
  }
  
  if (isAdmin(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot ban an admin! Remove their admin privileges first using .removeadmin", messageID);
    return;
  }
  
  const targetUserInfo = await getUserInfo(targetUserID);
  
  if (!targetUserInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo.nicknames?.[targetUserID] || targetUserInfo.name;
  const mentionName = mentions[targetUserID] || "";
  const reason = args.replace(mentionName, "").trim() || "Manual ban by admin";
  const bannerInfo = await getUserInfo(senderID);
  const bannerName = threadInfo.nicknames?.[senderID] || bannerInfo?.name || "Admin";

  const banResult = data.banMember(threadID, targetUserID, nickname, reason, bannerName);
  
  if (!banResult) {
    sendMessage(threadID, "❌ This user is already banned.", messageID);
    return;
  }

  const { uid, durationType, liftDate } = banResult;
  let durationMessage = `Ban Duration: ${durationType}`;
  
  if (liftDate) {
    const liftDateObj = new Date(liftDate);
    durationMessage += `\nBan will be lifted on: ${liftDateObj.toLocaleString('en-US', { timeZone: 'Asia/Manila' })}`;
  }

  sendMessage(threadID, `🔨 ${nickname} has been banned!\n\nReason: ${reason}\nBanned by: ${bannerName}\nBan ID: ${uid}\n${durationMessage}\n\nTo unban: .unban ${uid}`, messageID);

  setTimeout(() => {
    sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
    
    setTimeout(() => {
      api.removeUserFromGroup(targetUserID, threadID, (err) => {
        if (err) {
          console.error("Failed to remove user from group:", err);
          sendMessage(threadID, `❌ Failed to remove ${nickname} from the group. Please try removing manually.`, messageID);
        } else {
          console.log(`✅ Removed ${nickname} from group ${threadID}`);
        }
      });
    }, 1000);
  }, 1500);
}

async function handleBannedCommand(threadID, messageID) {
  const bannedMembers = data.getBannedMembers(threadID);
  
  if (bannedMembers.length === 0) {
    sendMessage(threadID, "📋 No banned members in this group.", messageID);
    return;
  }

  let message = `🚫 Banned Members (${bannedMembers.length})\n\n`;
  
  bannedMembers.forEach((ban, index) => {
    const date = new Date(ban.date).toLocaleDateString();
    message += `${index + 1}. ${ban.nickname}\n`;
    message += `   Ban ID: ${ban.uid}\n`;
    message += `   Reason: ${ban.reason}\n`;
    message += `   Banned by: ${ban.bannedBy}\n`;
    message += `   Date: ${date}\n`;
    
    if (ban.durationType) {
      message += `   Duration: ${ban.durationType}\n`;
      if (ban.liftDate) {
        const liftDate = new Date(ban.liftDate);
        message += `   Lifts on: ${liftDate.toLocaleString('en-US', { timeZone: 'Asia/Manila' })}\n`;
      }
    }
    message += `\n`;
  });

  message += `To unban: .unban [Ban ID]\n`;
  message += `Note: Permanent bans can only be lifted by the developer.`;

  sendMessage(threadID, message, messageID);
}

async function handleUnbanCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can unban members!", messageID);
    return;
  }

  const message = event.body;
  const args = message.substring(".unban ".length).trim();
  
  let identifier = args;
  let unbannedMember = null;

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length > 0) {
    identifier = mentionedUserIDs[0];
  } else if (event.messageReply && event.messageReply.senderID && !args) {
    identifier = event.messageReply.senderID;
  } else if (!args) {
    sendMessage(threadID, "❌ Usage: .unban @mention or .unban [Ban ID]\nExample: .unban A1B2C3\n\nAlternatively, reply to a message with: .unban", messageID);
    return;
  }

  const bannedMembers = data.getBannedMembers(threadID);
  const targetBan = bannedMembers.find(b => b.uid === identifier || b.userID === identifier);
  
  if (targetBan && targetBan.durationType === "permanent" && senderID !== DEVELOPER_ID) {
    sendMessage(threadID, "❌ This is a permanent ban and can only be lifted by the developer.", messageID);
    return;
  }

  unbannedMember = data.unbanMember(threadID, identifier);

  if (!unbannedMember) {
    sendMessage(threadID, "❌ User not found in ban list. Use .banned to see all banned members.", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  const unbannerInfo = await getUserInfo(senderID);
  const unbannerName = threadInfo?.nicknames?.[senderID] || unbannerInfo?.name || "Admin";

  console.log(`✅ ${unbannedMember.nickname} unbanned from group ${threadID} by ${unbannerName}`);
  sendMessage(threadID, `✅ ${unbannedMember.nickname} has been unbanned.\n\nThey can now rejoin the group manually.\n\nUnbanned by: ${unbannerName}\nOriginal ban reason: ${unbannedMember.reason}`, messageID);
}

async function handleRemoveAllBansCommand(threadID, messageID, senderID) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER or SUPER ADMIN can remove all bans!", messageID);
    return;
  }

  const adminInfo = await getUserInfo(senderID);
  const adminName = adminInfo?.name || "Admin";

  const result = data.removeAllBans(threadID);
  
  if (result.count === 0) {
    sendMessage(threadID, "📋 No bans found in this group.", messageID);
    return;
  }

  console.log(`✅ ${adminName} removed all ${result.count} bans in thread ${threadID}`);
  sendMessage(threadID, `✅ All bans have been removed!\n\nTotal bans cleared: ${result.count}\nCleared by: ${adminName}\n\nAll previously banned users can now rejoin the group and their ban records have been reset to 3 days duration.`, messageID);
}

async function handleRemoveAllWarningsCommand(threadID, messageID, senderID) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER or SUPER ADMIN can remove all warnings!", messageID);
    return;
  }

  const adminInfo = await getUserInfo(senderID);
  const adminName = adminInfo?.name || "Admin";

  const result = data.removeAllWarnings(threadID);
  
  if (result.count === 0) {
    sendMessage(threadID, "📋 No warnings found in this group.", messageID);
    return;
  }

  console.log(`✅ ${adminName} removed all warnings for ${result.count} users in thread ${threadID}`);
  sendMessage(threadID, `✅ All warnings have been removed!\n\nTotal users cleared: ${result.count}\nCleared by: ${adminName}\n\nAll users now have a clean warning record.`, messageID);
}

async function handleShutdownCommand(threadID, messageID, senderID) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER or SUPER ADMIN can shutdown the bot!", messageID);
    return;
  }

  const adminInfo = await getUserInfo(senderID);
  const adminName = adminInfo?.name || "Admin";

  console.log(`🛑 SHUTDOWN initiated by ${adminName} (${senderID}) for thread ${threadID}`);
  
  data.setGroupActive(threadID, false);
  
  sendMessage(threadID, `🛑 Bot is now shutting down for this group...\n\nInitiated by: ${adminName}\n\n⚠️ The bot will ignore all messages in this group until reactivated with .initialize\n\nGoodbye! 👋`, messageID);
}

async function processOfflineMessages(threadID, messages) {
  console.log(`🔍 Scanning ${messages.length} offline messages for thread ${threadID}...`);
  
  let textMessagesScanned = 0;
  let attachmentOnlyMessages = 0;
  let adminMessagesSkipped = 0;
  let emptyMessagesSkipped = 0;
  
  for (const msg of messages) {
    const { senderID, body, messageID: msgID, attachments } = msg;
    
    const message = body ? body.trim() : "";
    const hasAttachments = attachments && attachments.length > 0;
    
    if (!message && !hasAttachments) {
      emptyMessagesSkipped++;
      continue;
    }
    
    if (data.isAdminUser(threadID, senderID)) {
      adminMessagesSkipped++;
      continue;
    }
    
    const mockEvent = {
      threadID,
      messageID: msgID,
      senderID,
      body: message,
      attachments: attachments || []
    };
    
    try {
      if (message) {
        await checkForVulgarWords(threadID, msgID, senderID, message, mockEvent);
        await checkMessageSpam(threadID, msgID, senderID, message);
        textMessagesScanned++;
      } else if (hasAttachments) {
        attachmentOnlyMessages++;
      }
    } catch (e) {
      console.error(`⚠️ Error processing offline message ${msgID}:`, e);
    }
  }
  
  let summary = `📊 Offline Message Scan Complete\n\n` +
               `• Total messages: ${messages.length}\n` +
               `• Text messages scanned: ${textMessagesScanned}\n`;
  
  if (attachmentOnlyMessages > 0) {
    summary += `• Attachment-only messages (not scanned): ${attachmentOnlyMessages}\n`;
  }
  if (adminMessagesSkipped > 0) {
    summary += `• Admin messages (exempt): ${adminMessagesSkipped}\n`;
  }
  if (emptyMessagesSkipped > 0) {
    summary += `• Empty messages: ${emptyMessagesSkipped}\n`;
  }
  
  summary += `\n✅ `;
  if (textMessagesScanned > 0) {
    summary += `${textMessagesScanned} text message${textMessagesScanned > 1 ? 's' : ''} scanned for policy violations.`;
  } else {
    summary += `No text messages required scanning.`;
  }
  
  if (attachmentOnlyMessages > 0) {
    summary += `\n⚠️ ${attachmentOnlyMessages} attachment-only message${attachmentOnlyMessages > 1 ? 's' : ''} could not be scanned (text scanning only).`;
  }
  
  sendMessage(threadID, summary);
  
  console.log(`✅ Offline scan complete: ${messages.length} total, ${textMessagesScanned} text scanned, ${attachmentOnlyMessages} attachment-only, ${adminMessagesSkipped} admin, ${emptyMessagesSkipped} empty`);
}

async function handleInitializeCommand(threadID, messageID, senderID) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER or SUPER ADMIN can initialize the bot!", messageID);
    return;
  }

  const adminInfo = await getUserInfo(senderID);
  const adminName = adminInfo?.name || "Admin";

  console.log(`🚀 INITIALIZE initiated by ${adminName} (${senderID}) for thread ${threadID}`);
  
  data.setGroupActive(threadID, true);
  
  const offlineMessages = data.getOfflineMessages(threadID);
  const messageCount = offlineMessages.length;
  
  sendMessage(threadID, `🚀 Bot is now active in this group!\n\nInitiated by: ${adminName}\n\n✅ The bot will now respond to all commands and monitor the group.\n\n📦 Processing ${messageCount} offline messages...\n\nWelcome back! 👋`, messageID);
  
  if (messageCount > 0) {
    console.log(`📦 Processing ${messageCount} offline messages for thread ${threadID}...`);
    await processOfflineMessages(threadID, offlineMessages);
    data.clearOfflineMessages(threadID);
    console.log(`✅ Finished processing offline messages for thread ${threadID}`);
  }
}

async function handleSecretCommand(threadID, messageID, senderID) {
  if (!isDeveloper(senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER can use this command!", messageID);
    return;
  }

  const enabled = data.toggleFakeWarning(threadID);
  if (enabled) {
    sendMessage(threadID, "✅ Secret mode ENABLED!\n\nFake warnings will be sent randomly (2 times per month max).", messageID);
  } else {
    sendMessage(threadID, "✅ Secret mode DISABLED!\n\nNo more fake warnings will be sent.", messageID);
  }
}

async function handleInfoCommand(threadID, messageID, senderID, event) {
  const message = event.body;
  const mentions = event.mentions;
  
  let targetUserID;
  
  if (message === ".info me") {
    targetUserID = senderID;
  } else if (!mentions || Object.keys(mentions).length === 0) {
    sendMessage(threadID, "❌ Please mention a user to view their info!\n\nUsage: .info @user or .info me", messageID);
    return;
  } else {
    targetUserID = Object.keys(mentions)[0];
  }

  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  
  if (!userInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo.name || "User";
  
  let role = "";
  let roleEmoji = "";
  if (isDeveloper(targetUserID)) {
    role = "*DEVELOPER*";
    roleEmoji = "👨‍💻";
  } else if (isSuperAdmin(targetUserID)) {
    role = "*SUPER ADMIN*";
    roleEmoji = "👑";
  } else if (isAdmin(threadID, targetUserID)) {
    role = "*ADMIN*";
    roleEmoji = "💻";
  } else {
    role = "_Member_";
    roleEmoji = "✅";
  }

  const banCount = data.getBanCount(threadID, targetUserID);
  let banStatus = "✅ No violations";
  if (banCount === 1) {
    banStatus = "⚠️ 1 violation";
  } else if (banCount === 2) {
    banStatus = "🚨 2 violations - IMMINENT REMOVAL";
  } else if (banCount >= 3) {
    banStatus = `🔴 ${banCount} violations - PERMANENTLY BANNED`;
  }

  const warnings = data.getWarningCount(threadID, targetUserID);
  let warningStatus = `${warnings}`;
  if (warnings === 2) {
    warningStatus = `${warnings} - IMMINENT BAN`;
  } else if (warnings >= 3) {
    warningStatus = `${warnings} - BANNED`;
  }
  
  const warningsList = data.getAllWarnings(threadID).find(w => w.userID === targetUserID);
  let warningsText = "None";
  if (warningsList && warningsList.reasons && warningsList.reasons.length > 0) {
    warningsText = warningsList.reasons.map((r, i) => {
      const timestamp = r.date || 'No timestamp';
      return `  ${i + 1}. ${r.reason}\n     📅 ${timestamp}${r.permanent ? ' [🔒 PERMANENT]' : ''}`;
    }).join('\n\n');
  }

  const joinDate = data.getMemberJoinDate(threadID, targetUserID);
  const joinDateFormatted = joinDate 
    ? new Date(joinDate).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
    : "Unknown";

  const kickCount = data.getKickCount(threadID, targetUserID);

  let infoMessage = `\n`;
  infoMessage += `👤 USER INFORMATION:\n`;
  infoMessage += `\n\n`;
  infoMessage += `> 📝 Name: ${nickname}\n`;
  infoMessage += `> ${roleEmoji} Role: ${role}\n`;
  infoMessage += `> 🆔 UID: ${targetUserID}\n\n`;
  infoMessage += `\n`;
  infoMessage += `📊 MODERATION INFO:\n`;
  infoMessage += `\n\n`;
  infoMessage += `- 🚫 Ban Status: ${banStatus}\n`;
  infoMessage += `- ⚠️ Warnings: ${warningStatus}\n`;
  if (warningsList && warningsList.reasons && warningsList.reasons.length > 0) {
    infoMessage += `\n📋 Warning History:\n${warningsText}\n`;
  }
  infoMessage += `\n👢 Kick Count: ${kickCount}\n`;
  infoMessage += `📆 Member Since: ${joinDateFormatted}`;

  sendMessage(threadID, infoMessage, messageID);
}

async function handleWarExtremeCommand(threadID, messageID, senderID) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can use this command!", messageID);
    return;
  }

  data.setWarExtremeMode(threadID, true);
  sendMessage(threadID, "⚠️ WAR EXTREME MODE ACTIVATED!\n\nAll vulgar word detection has been disabled. Group members can use any language without warnings.\n\nUse .peace to restore normal mode.", messageID);
}

async function handlePeaceCommand(threadID, messageID, senderID) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can use this command!", messageID);
    return;
  }

  data.setWarExtremeMode(threadID, false);
  sendMessage(threadID, "✅ PEACE MODE ACTIVATED!\n\nVulgar word detection has been re-enabled. All warning rules are now active.\n\nUse .warextreme to disable warnings again.", messageID);
}

async function handleKickCommand(threadID, messageID, senderID, event) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can kick members!", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) {
    sendMessage(threadID, "❌ Error: Could not retrieve group information.", messageID);
    return;
  }

  const message = event.body;
  const args = message.substring(".kick ".length).trim();
  
  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .kick @mention [reason]\nKick a user from the group.\n\nAlternatively, reply to a message with: .kick [reason]", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  
  if (isProtectedUser(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot kick the developer or super admin!", messageID);
    return;
  }
  
  if (isAdmin(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot kick admins!", messageID);
    return;
  }

  const targetUserInfo = await getUserInfo(targetUserID);
  
  if (!targetUserInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo.nicknames?.[targetUserID] || targetUserInfo.name;
  const mentionName = mentions[targetUserID] || "";
  const reason = args.replace(mentionName, "").trim() || "Kicked by admin";
  const kickerInfo = await getUserInfo(senderID);
  const kickerName = threadInfo.nicknames?.[senderID] || kickerInfo?.name || "Admin";

  console.log(`👢 ${kickerName} is kicking ${nickname} from group ${threadID}`);

  sendMessage(threadID, `👢 ${nickname} has been kicked from the group.\n\nReason: ${reason}\nKicked by: ${kickerName}`, messageID);
  
  setTimeout(() => {
    sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
    
    setTimeout(() => {
      api.removeUserFromGroup(targetUserID, threadID, (err) => {
        if (err) {
          console.error("Failed to remove user from group:", err);
          sendMessage(threadID, `❌ Failed to kick ${nickname}. Please try again or remove manually.`, messageID);
        } else {
          const kickCount = data.incrementKickCount(threadID, targetUserID);
          data.removeMember(threadID, targetUserID);
          console.log(`✅ Kicked ${nickname} from group ${threadID} (kick count: ${kickCount})`);
        }
      });
    }, 1000);
  }, 1000);
}

async function handleVonCommand(threadID, messageID) {
  const message = "Website Ni Von\nhttps://von.x10.mx\n\nLibre dox mga yawa";
  sendMessage(threadID, message, messageID);
}

async function handleAddAdminCommand(threadID, messageID, senderID, event) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the Developer and Super Admin can add admins in this group!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .addmin @mention\nMention a user to make them an admin in this group.\n\nAlternatively, reply to a message with: .addmin", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];

  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  
  if (!userInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo.name;
  
  const success = data.addGroupAdmin(threadID, targetUserID);
  
  if (!success) {
    sendMessage(threadID, `❌ ${nickname} is already an admin in this group!`, messageID);
    return;
  }
  
  data.setGlobalAdmins(ADMIN_IDS, [DEVELOPER_ID]);
  
  console.log(`✅ ${nickname} (${targetUserID}) has been added as admin in thread ${threadID}`);
  sendMessage(threadID, `✅ ${nickname} has been promoted to admin in this group!\n\nUID: ${targetUserID}`, messageID);
}

async function handleRemoveAdminCommand(threadID, messageID, senderID, event) {
  if (!isProtectedUser(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the Developer and Super Admin can remove admins in this group!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .removeadmin @mention\nMention a user to remove them as admin in this group.\n\nAlternatively, reply to a message with: .removeadmin", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];
  
  if (isProtectedUser(threadID, targetUserID)) {
    sendMessage(threadID, "❌ Cannot remove the developer or super admin!", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  
  if (!userInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo.name;
  
  const success = data.removeGroupAdmin(threadID, targetUserID);
  
  if (!success) {
    sendMessage(threadID, `❌ ${nickname} is not an admin in this group!`, messageID);
    return;
  }
  
  data.setGlobalAdmins(ADMIN_IDS, [DEVELOPER_ID]);
  
  console.log(`✅ ${nickname} (${targetUserID}) has been removed as admin in thread ${threadID}`);
  sendMessage(threadID, `✅ ${nickname} has been removed as admin in this group.\n\nUID: ${targetUserID}`, messageID);
}

async function handleSupAddminCommand(threadID, messageID, senderID, event) {
  if (!isDeveloper(senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER can add super admins!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .supaddmin @mention\nMention a user to promote them to super admin in this group.\n\nNote: Maximum 3 super admins per group.\n\nAlternatively, reply to a message with: .supaddmin", messageID);
      return;
    }
  }

  const targetUserID = mentionedUserIDs[0];

  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  
  if (!userInfo) {
    sendMessage(threadID, "❌ Could not retrieve user information.", messageID);
    return;
  }

  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo.name;
  
  const result = data.addSuperAdmin(threadID, targetUserID);
  
  if (!result.success) {
    if (result.reason === "already_super_admin") {
      sendMessage(threadID, `❌ ${nickname} is already a super admin in this group!`, messageID);
    } else if (result.reason === "max_limit_reached") {
      sendMessage(threadID, `❌ This group already has 3 super admins (maximum limit)!\n\nRemove a super admin first before adding a new one.`, messageID);
    }
    return;
  }
  
  console.log(`✅ ${nickname} (${targetUserID}) has been added as super admin in thread ${threadID}`);
  sendMessage(threadID, `✅ ${nickname} has been promoted to SUPER ADMIN 👑 in this group!\n\nUID: ${targetUserID}\n\nSuper admins have elevated privileges and can manage group admins.`, messageID);
}

async function handleRemoveBanRecordCommand(threadID, messageID, senderID, event) {
  if (!isDeveloper(senderID) && !isSuperAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only the DEVELOPER and SUPER ADMIN can reset ban records!", messageID);
    return;
  }

  const mentions = event.mentions || {};
  let mentionedUserIDs = Object.keys(mentions);
  
  if (mentionedUserIDs.length === 0) {
    if (event.messageReply && event.messageReply.senderID) {
      mentionedUserIDs = [event.messageReply.senderID];
    } else {
      sendMessage(threadID, "❌ Usage: .removebanrecord @mention\nMention a user to reset their ban count to 0.\n\nAlternatively, reply to a message with: .removebanrecord", messageID);
      return;
    }
  }
  
  const targetUserID = mentionedUserIDs[0];

  const threadInfo = await getThreadInfo(threadID);
  const userInfo = await getUserInfo(targetUserID);
  const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo?.name || "User";
  const adminInfo = await getUserInfo(senderID);
  const adminName = threadInfo?.nicknames?.[senderID] || adminInfo?.name || "Admin";
  
  const previousBanCount = data.getBanCount(threadID, targetUserID);
  const resetSuccess = data.resetBanCount(threadID, targetUserID);
  
  if (resetSuccess) {
    sendMessage(threadID, `✅ Ban record reset for ${nickname} by ${adminName}.\n\nPrevious ban count: ${previousBanCount}\nNew ban count: 0\n\nTheir next ban will be treated as a first offense (3 days).`, messageID);
    console.log(`✅ Reset ban count for ${nickname} (${targetUserID}) in thread ${threadID} by ${adminName} (${senderID})`);
  } else {
    sendMessage(threadID, `❌ ${nickname} has no ban records to reset!`, messageID);
  }
}

async function handleAdminListCommand(threadID, messageID) {
  const groupAdmins = data.getGroupAdmins(threadID) || [];
  const superAdmins = data.getSuperAdmins(threadID) || [];
  
  let adminList = "📋 Admin List for this Group:\n\n";
  let index = 1;
  
  let threadInfo;
  try {
    threadInfo = await getThreadInfo(threadID);
  } catch (err) {
    console.error("Failed to get thread info:", err);
    sendMessage(threadID, "❌ Error: Could not retrieve group information. Please try again later.", messageID);
    return;
  }
  
  try {
    const developerInfo = await getUserInfo(DEVELOPER_ID);
    const developerNickname = threadInfo?.nicknames?.[DEVELOPER_ID] || developerInfo?.name || "Developer";
    adminList += `${index}. ${developerNickname} 👨‍💻 (DEVELOPER)\n   UID: ${DEVELOPER_ID}\n\n`;
  } catch (err) {
    console.error("Failed to get developer info:", err);
    adminList += `${index}. Developer 🧑‍💻 (DEVELOPER)\n   UID: ${DEVELOPER_ID}\n\n`;
  }
  index++;
  
  for (const superAdminID of superAdmins) {
    try {
      const userInfo = await getUserInfo(superAdminID);
      const nickname = threadInfo?.nicknames?.[superAdminID] || userInfo?.name || "Unknown User";
      adminList += `${index}. ${nickname} 👑 (SUPER ADMIN)\n   UID: ${superAdminID}\n\n`;
      index++;
    } catch (err) {
      console.error(`Failed to get super admin info for ${superAdminID}:`, err);
      adminList += `${index}. Super Admin 👑 (SUPER ADMIN)\n   UID: ${superAdminID}\n\n`;
      index++;
    }
  }
  
  for (let i = 0; i < groupAdmins.length; i++) {
    const adminID = groupAdmins[i];
    
    if (adminID === DEVELOPER_ID || superAdmins.includes(adminID)) {
      continue;
    }
    
    try {
      const userInfo = await getUserInfo(adminID);
      const nickname = threadInfo?.nicknames?.[adminID] || userInfo?.name || "Unknown User";
      
      adminList += `${index}. ${nickname}\n   UID: ${adminID}\n\n`;
      index++;
    } catch (err) {
      console.error(`Failed to get user info for admin ${adminID}:`, err);
      adminList += `${index}. Unknown User\n   UID: ${adminID}\n\n`;
      index++;
    }
  }
  
  if (index === 2 && groupAdmins.length === 0 && superAdmins.length === 0) {
    adminList += "No other admins have been assigned to this group yet.\n\nUse .addmin @user to add admins or .supaddmin @user to add super admins (DEVELOPER only).";
  }

  sendMessage(threadID, adminList.trim(), messageID);
}

async function handleBanAllCommand(threadID, messageID, senderID) {
  if (!isDeveloper(senderID) && !isSuperAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ This command can only be used by the DEVELOPER or a SUPER ADMIN!", messageID);
    return;
  }

  const threadInfo = await getThreadInfo(threadID);
  if (!threadInfo) {
    sendMessage(threadID, "❌ Error: Could not retrieve group information.", messageID);
    return;
  }

  sendMessage(threadID, "⚠️ BANALL INITIATED!\n\nBanning and removing all members including admins and bot...", messageID);

  let bannedCount = 0;
  const participantIDs = [...threadInfo.participantIDs];

  for (const userID of participantIDs) {
    const userInfo = await getUserInfo(userID);
    const nickname = threadInfo.nicknames?.[userID] || userInfo?.name || "Unknown User";
    
    const uid = data.banMember(
      threadID,
      userID,
      nickname,
      "Banned by DEVELOPER - BANALL command",
      "DEVELOPER"
    );

    if (uid) {
      api.removeUserFromGroup(userID, threadID, (err) => {
        if (err) {
          console.error(`Failed to remove ${nickname}:`, err);
        } else {
          console.log(`✅ Banned and removed ${nickname} (${userID})`);
        }
      });
      bannedCount++;
    }
  }

  console.log(`🚫 BANALL completed: ${bannedCount} users banned and removed from thread ${threadID}`);
}

async function handleServerCommand(threadID, messageID) {
  const serverInfo = data.getServerInfo(threadID);
  
  if (!serverInfo) {
    sendMessage(threadID, "❌ No server information set for this group.\n\nAdmins can set it with: .serverinfo [ip:port]", messageID);
    return;
  }

  sendMessage(threadID, `🖥️ Server Information:\n\n${serverInfo}`, messageID);
}

async function handleServerInfoCommand(threadID, messageID, senderID, message) {
  if (!isAdmin(threadID, senderID)) {
    sendMessage(threadID, "❌ Only admins can set server information!", messageID);
    return;
  }

  const serverInfo = message.substring(".serverinfo ".length).trim();
  
  if (!serverInfo) {
    sendMessage(threadID, "❌ Please provide server information!\n\nUsage: .serverinfo [ip:port]\nExample: .serverinfo 192.168.1.100:25565", messageID);
    return;
  }

  data.setServerInfo(threadID, serverInfo);
  sendMessage(threadID, `✅ Server information updated!\n\n🖥️ ${serverInfo}`, messageID);
}

async function handleInvalidCommand(threadID, messageID, senderID, message) {
  if (isProtectedUser(threadID, senderID)) {
    const invalidResponses = [
      "walang ganyan bonak",
      "Walang command na ganyan",
      "Marunong kaba mag display ng help?",
      "Jusko po",
      "Walang command na ganyan inutil",
      "eengot-engot mag command"
    ];
    const randomResponse = invalidResponses[Math.floor(Math.random() * invalidResponses.length)];
    sendMessage(threadID, randomResponse, messageID);
    return;
  }

  const key = `${threadID}_${senderID}`;
  const now = Date.now();
  
  if (!spamDetection.has(key)) {
    spamDetection.set(key, { commands: [], lastReset: now, warned: false });
  }

  const userSpam = spamDetection.get(key);
  
  if (now - userSpam.lastReset > 10000) {
    userSpam.commands = [];
    userSpam.lastReset = now;
    userSpam.warned = false;
  }

  userSpam.commands.push(message);

  if (userSpam.commands.length === 3 && !userSpam.warned) {
    userSpam.warned = true;
    sendMessage(threadID, "⚠️ Warning: You're spamming invalid commands. If you continue, you will receive a permanent warning!\n\nUse .help to see available commands and avoid consequences.", messageID);
    return;
  }

  if (userSpam.commands.length >= 5 && !userSpam.permanentWarningIssued) {
    userSpam.permanentWarningIssued = true;
    
    const threadInfo = await getThreadInfo(threadID);
    const userInfo = await getUserInfo(senderID);
    const nickname = threadInfo?.nicknames?.[senderID] || userInfo?.name || "User";

    console.log(`⚠️ Permanent warning for ${nickname} for spamming invalid commands`);
    
    await issueWarning(threadID, messageID, senderID, { body: message }, "Spamming (5 invalid commands in 10 seconds)", true);

    spamDetection.delete(key);
    return;
  }
  
  if (userSpam.commands.length >= 5) {
    return;
  }

  const invalidResponses = [
    "walang ganyan bonak",
    "Walang command na ganyan",
    "Marunong kaba mag display ng help?",
    "Jusko po",
    "Walang command na ganyan inutil",
    "eengot-engot mag command"
  ];
  const randomResponse = invalidResponses[Math.floor(Math.random() * invalidResponses.length)];
  sendMessage(threadID, randomResponse, messageID);
}

async function handleUnsendMessage(event) {
  const { threadID, senderID, messageID } = event;
  
  if (!threadID || !senderID) return;
  
  if (isProtectedUser(threadID, senderID)) {
    console.log("⏭️ Skipping unsend notification for protected user");
    return;
  }
  
  const cachedMessage = data.getCachedMessage(messageID);
  
  if (!cachedMessage) {
    console.log("⚠️ Message not found in cache (may have expired)");
    return;
  }
  
  const userInfo = await getUserInfo(senderID);
  const threadInfo = await getThreadInfo(threadID);
  const nickname = threadInfo?.nicknames?.[senderID] || userInfo?.name || "Someone";
  
  console.log(`🔄 Message unsent by ${nickname} (${senderID}) in thread ${threadID}`);
  
  const hasImages = cachedMessage.attachments && cachedMessage.attachments.some(att => att.type === 'photo');
  
  if (hasImages) {
    const imageAttachments = cachedMessage.attachments.filter(att => att.type === 'photo');
    const sentTime = new Date(cachedMessage.timestamp).toLocaleString('en-US', { 
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const unsentTime = new Date().toLocaleString('en-US', { 
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    
    let groupMessage = `⚠️ ${nickname} has unsent a photo!\n\n`;
    groupMessage += `📅 Sent: ${sentTime} (PHT)\n`;
    groupMessage += `🗑️ Unsent: ${unsentTime} (PHT)\n`;
    
    if (cachedMessage.body) {
      groupMessage += `\n💬 Caption: "${cachedMessage.body}"\n`;
    }
    
    console.log(`📤 Sending unsent photo to group chat (${threadID})`);
    console.log(`📸 Image count: ${imageAttachments.length}`);
    
    sendMessage(threadID, groupMessage);
    
    setTimeout(() => {
      imageAttachments.forEach((att, i) => {
        if (att.url) {
          const attachment = {
            url: att.url
          };
          
          api.sendMessage({ attachment }, threadID, (err) => {
            if (err) {
              console.error(`❌ Failed to send unsent image ${i + 1}:`, err);
            } else {
              console.log(`✅ Successfully sent unsent image ${i + 1} to group chat`);
            }
          });
        }
      });
    }, 1000);
    
    return;
  }
  
  const unsentKey = `${threadID}_${senderID}`;
  const now = Date.now();
  
  if (!unsentSpamTracking.has(unsentKey)) {
    unsentSpamTracking.set(unsentKey, { count: 0, lastUnsent: now, warned: false });
  }
  
  const unsentData = unsentSpamTracking.get(unsentKey);
  
  if (now - unsentData.lastUnsent > 60000) {
    unsentData.count = 0;
    unsentData.warned = false;
  }
  
  unsentData.count++;
  unsentData.lastUnsent = now;
  
  if (unsentData.count === 3 && !unsentData.warned) {
    sendMessage(threadID, "⚠️ Warning: You're spamming unsent messages. If you continue, you will receive a permanent warning!\n\nUse .help to see available commands and avoid consequences.");
    unsentData.warned = true;
  }
  
  if (unsentData.count >= 5) {
    console.log(`⚠️ Permanent warning for ${nickname} for spamming unsent messages`);
    
    await issueWarning(threadID, null, senderID, { body: "" }, "Spamming unsent messages (5 unsends in 60 seconds)", true);
    
    unsentSpamTracking.delete(unsentKey);
    return;
  }
  
  const sentTime = new Date(cachedMessage.timestamp).toLocaleString('en-US', { 
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  const unsentTime = new Date().toLocaleString('en-US', { 
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  
  let revealMessage = `⚠️ ${nickname} unsent a message!\n\n`;
  revealMessage += `📅 Sent: ${sentTime} (PHT)\n`;
  revealMessage += `🗑️ Unsent: ${unsentTime} (PHT)\n\n`;
  
  if (cachedMessage.body) {
    revealMessage += `💬 Message: "${cachedMessage.body}"\n\n`;
  }
  
  if (cachedMessage.attachments && cachedMessage.attachments.length > 0) {
    revealMessage += `📎 Attachments: ${cachedMessage.attachments.length} file(s)\n`;
    for (let i = 0; i < Math.min(cachedMessage.attachments.length, 3); i++) {
      const att = cachedMessage.attachments[i];
      if (att.url) {
        revealMessage += `${i + 1}. ${att.url}\n`;
      }
    }
  }
  
  sendMessage(threadID, revealMessage.trim());
  console.log(`✅ Automatically revealed unsent message from ${nickname}`);
}

async function handleGroupEvent(event) {
  if (event.logMessageType === "log:subscribe") {
    const threadID = event.threadID;
    const addedUserIDs = event.logMessageData.addedParticipants.map(p => p.userFbId);
    const adderID = event.author;

    const threadInfo = await getThreadInfo(threadID);
    if (!threadInfo) return;

    await updateGroupMembers(threadID, threadInfo);
    
    const isAdderTrusted = isDeveloper(adderID) || isSuperAdmin(threadID, adderID) || isAdmin(threadID, adderID);
    
    if (isAdderTrusted) {
      console.log(`✅ Trusted user (${adderID}) added ${addedUserIDs.length} member(s) to the group`);
    } else {
      console.log(`⚠️ Regular user (${adderID}) added ${addedUserIDs.length} member(s) - adding to pending approval queue`);
    }

    for (const userID of addedUserIDs) {
      data.setMemberJoinDate(threadID, userID);
      console.log(`📅 Recorded join date for user ${userID} in thread ${threadID}`);
      
      if (userID === botUserId) {
        console.log("⏭️ Bot was added to group, changing nickname to TENSURA");
        api.changeNickname("TENSURA", threadID, botUserId, (err) => {
          if (err) {
            console.log(`⚠️ Could not change bot nickname to TENSURA in thread ${threadID}:`, err);
          } else {
            console.log(`✅ Bot nickname changed to TENSURA in thread ${threadID}`);
          }
        });
        
        console.log("⏳ Waiting 10 seconds before scanning group admins...");
        setTimeout(async () => {
          console.log("🔍 Scanning and removing unauthorized group admins...");
          
          api.getThreadInfo(threadID, async (err, info) => {
            if (err) {
              console.error(`❌ Failed to get thread info for admin scanning:`, err);
              return;
            }
            
            const groupAdminIDs = info.adminIDs || [];
            console.log(`📋 Found ${groupAdminIDs.length} group admins:`, groupAdminIDs.map(a => a.id || a));
            
            const superAdmins = data.getSuperAdmins(threadID);
            const allowedAdmins = [DEVELOPER_ID, ...superAdmins, botUserId];
            
            for (const adminEntry of groupAdminIDs) {
              const adminID = adminEntry.id || adminEntry;
              
              if (!allowedAdmins.includes(adminID)) {
                console.log(`🚫 Removing unauthorized admin: ${adminID}`);
                
                api.changeAdminStatus(threadID, adminID, false, (removeErr) => {
                  if (removeErr) {
                    console.error(`❌ Failed to remove admin ${adminID}:`, removeErr);
                  } else {
                    console.log(`✅ Successfully removed admin ${adminID} from group ${threadID}`);
                  }
                });
              } else {
                console.log(`✅ Keeping authorized admin: ${adminID}`);
              }
            }
            
            console.log("✅ Admin scanning complete!");
          });
        }, 10000);
        
        continue;
      }

      if (data.isBanned(threadID, userID)) {
        const userInfo = await getUserInfo(userID);
        const nickname = userInfo?.name || "User";
        
        console.log(`⚠️ Banned user ${nickname} (${userID}) attempted to join group ${threadID}`);
        
        sendMessage(threadID, `🚫 ${nickname} is banned and will be automatically removed.\n\nUse .banned to see the ban list or .unban to remove the ban.`);
        
        setTimeout(() => {
          api.removeUserFromGroup(userID, threadID, (err) => {
            if (err) {
              console.error(`Failed to auto-kick banned user ${nickname}:`, err);
              sendMessage(threadID, `❌ Auto-kick failed for ${nickname}. Please remove manually.`);
            } else {
              console.log(`✅ Auto-kicked banned user ${nickname} from group ${threadID}`);
            }
          });
        }, 1500);
        continue;
      }

      const userInfo = await getUserInfo(userID);
      if (!userInfo) continue;

      const nickname = threadInfo.nicknames?.[userID] || userInfo.name;
      
      if (userID === botUserId) {
        api.changeNickname("TENSURA", threadID, botUserId, (err) => {
          if (err) {
            console.log(`⚠️ Could not change bot nickname to TENSURA in thread ${threadID}:`, err);
          } else {
            console.log(`✅ Bot nickname changed to TENSURA in thread ${threadID}`);
          }
        });
        continue;
      }
      
      if (!isAdmin(threadID, userID)) {
        data.addMember(threadID, userID, nickname);
      }

      const greeting = data.getGreeting(threadID);
      const welcomeMessage = greeting.replace("{name}", nickname);
      
      sendMessage(threadID, welcomeMessage);
      
      try {
        const createdTime = userInfo.createdTime ? new Date(parseInt(userInfo.createdTime) * 1000).toLocaleDateString() : "Unknown";
        const gender = userInfo.gender || "Not specified";
        const profileUrl = userInfo.profileUrl || "Not available";
        
        let notificationMessage = `🔔 New User Added to Group\n\n`;
        notificationMessage += `Name: ${nickname}\n`;
        notificationMessage += `UID: ${userID}\n`;
        notificationMessage += `Account Creation Date: ${createdTime}\n`;
        notificationMessage += `Gender: ${gender}\n`;
        notificationMessage += `Profile: ${profileUrl}`;
        
        api.sendMessage(notificationMessage, DEVELOPER_ID, (err) => {
          if (err) {
            console.error(`Failed to notify developer about new user:`, err);
          } else {
            console.log(`✅ Notified developer about new user ${nickname}`);
          }
        });
      } catch (error) {
        console.error(`Error sending new user notification:`, error);
      }
    }
  } else if (event.logMessageType === "log:unsubscribe") {
    const threadID = event.threadID;
    const removedUserIDs = event.logMessageData.leftParticipantFbId 
      ? [event.logMessageData.leftParticipantFbId]
      : [];

    for (const userID of removedUserIDs) {
      if (userID === botUserId) {
        console.log("⏭️ Bot was removed from group");
        continue;
      }
      
      if (userID === DEVELOPER_ID) {
        console.log(`🚨 FAIL-SAFE MECHANISM ACTIVATED! Developer was removed from group ${threadID}`);
        
        data.unbanMember(threadID, DEVELOPER_ID);
        
        const kicker = event.logMessageData.removedParticipantFbId || event.author;
        
        setTimeout(() => {
          api.addUserToGroup(DEVELOPER_ID, threadID, (err) => {
            if (err) {
              console.error(`❌ FAIL-SAFE: Failed to re-add developer:`, err);
              api.sendMessage(`🚨 FAIL-SAFE MECHANISM TRIGGERED\n\nI was removed from group ${threadID} but failed to rejoin automatically. Please add me back manually!`, DEVELOPER_ID);
            } else {
              console.log(`✅ FAIL-SAFE: Developer re-added to group`);
              
              sendMessage(threadID, `🚨 FAIL-SAFE PROTOCOL INITIATED 🚨\n\n⚠️ CRITICAL SYSTEM ALERT ⚠️\n\nThe DEVELOPER has been automatically restored to the group to prevent system failures and maintain operational integrity.\n\nThis automated protection mechanism ensures continuous group management and prevents unauthorized administrative changes.\n\n✅ System Status: RESTORED\n🛡️ Protection Level: MAXIMUM`);
              
              if (kicker && kicker !== DEVELOPER_ID) {
                setTimeout(() => {
                  api.removeUserFromGroup(kicker, threadID, (err) => {
                    if (err) {
                      console.error(`❌ FAIL-SAFE: Failed to remove kicker:`, err);
                    } else {
                      console.log(`✅ FAIL-SAFE: Removed the user who kicked developer`);
                      sendMessage(threadID, `⚖️ Unauthorized removal detected. Countermeasure executed.`);
                    }
                  });
                }, 3000);
              }
            }
          });
        }, 2000);
        
        continue;
      }

      const removedMember = data.removeMember(threadID, userID);
      if (removedMember) {
        console.log(`👋 ${removedMember.nickname} was removed from group and attendance list`);
      }
    }
  } else if (event.logMessageType === "log:thread-admins") {
    const threadID = event.threadID;
    const targetUserID = event.logMessageData.TARGET_ID;
    const isPromotion = event.logMessageData.ADMIN_EVENT === "add_admin";
    
    if (!isPromotion) {
      console.log(`⏭️ User ${targetUserID} was demoted from admin, no action needed`);
      return;
    }
    
    const superAdmins = data.getSuperAdmins(threadID);
    const allowedAdmins = [DEVELOPER_ID, ...superAdmins, botUserId];
    
    if (allowedAdmins.includes(targetUserID)) {
      console.log(`✅ Allowed admin ${targetUserID} was promoted`);
      return;
    }
    
    console.log(`⚠️ Unauthorized admin promotion detected: ${targetUserID}`);
    
    const userInfo = await getUserInfo(targetUserID);
    const threadInfo = await getThreadInfo(threadID);
    const nickname = threadInfo?.nicknames?.[targetUserID] || userInfo?.name || "User";
    
    api.changeAdminStatus(threadID, targetUserID, false, (err) => {
      if (err) {
        console.error(`❌ Failed to demote unauthorized admin ${nickname}:`, err);
        sendMessage(threadID, `⚠️ Warning: ${nickname} was promoted to admin but automatic demotion failed.\n\nOnly the Super Admin, Developer, and Bot are allowed to be group admins.`);
      } else {
        console.log(`✅ Successfully demoted unauthorized admin ${nickname}`);
        sendMessage(threadID, `🔒 Admin Protection System Activated\n\n${nickname} has been automatically demoted from admin.\n\n⚠️ ONLY the following users can be group admins:\n👑 Super Admin\n⭐ Developer\n🤖 Bot\n\nThis is an automated protection to maintain group security.`);
      }
    });
  }
}

async function updateGroupMembers(threadID, threadInfo) {
  if (!threadInfo || !threadInfo.participantIDs) return;

  const recentlyAddedUserIDs = [];
  for (const [key, timestamp] of recentlyAddedUsers.entries()) {
    if (key.startsWith(`${threadID}_`) && Date.now() - timestamp < 5000) {
      const userID = key.split('_')[1];
      recentlyAddedUserIDs.push(userID);
    }
  }

  const syncResult = data.syncGroupMembers(threadID, threadInfo.participantIDs, botUserId, recentlyAddedUserIDs);
  
  if (syncResult.removed.length > 0) {
    console.log(`🔄 Removed ${syncResult.removed.length} users who left the group from attendance:`);
    syncResult.removed.forEach(member => {
      console.log(`   - ${member.nickname} (${member.userID})`);
    });
  }

  for (const userID of threadInfo.participantIDs) {
    if (userID === botUserId) {
      console.log("⏭️ Skipping bot from attendance tracking");
      continue;
    }

    if (isProtectedUser(threadID, userID)) {
      console.log("⏭️ Skipping protected user (developer/super admin) from attendance tracking");
      data.removeMember(threadID, userID);
      continue;
    }

    if (isAdmin(threadID, userID)) {
      console.log("⏭️ Skipping admin from attendance tracking");
      data.removeMember(threadID, userID);
      continue;
    }

    const userInfo = await getUserInfo(userID);
    if (!userInfo) continue;

    const nickname = threadInfo.nicknames?.[userID] || userInfo.name;
    
    data.addMember(threadID, userID, nickname);
  }
}

async function getThreadInfo(threadID, forceRefresh = false) {
  if (forceRefresh && api.ctx && api.ctx.threadInfoCache) {
    api.ctx.threadInfoCache.delete(threadID);
  }
  
  return new Promise((resolve) => {
    api.getThreadInfo(threadID, (err, info) => {
      if (err) {
        console.error("Failed to get thread info:", err);
        resolve(null);
      } else {
        resolve(info);
      }
    });
  });
}

async function getUserInfo(userID) {
  return new Promise((resolve) => {
    api.getUserInfo(userID, (err, info) => {
      if (err) {
        console.error("Failed to get user info:", err);
        resolve(null);
      } else {
        resolve(info[userID]);
      }
    });
  });
}

function sendMessage(threadID, message, messageID = null) {
  console.log("📤 Attempting to send message:", { threadID, messagePreview: message.substring(0, 50) });
  
  const msgObj = {
    body: message
  };
  
  api.sendMessage(msgObj, threadID, (err, info) => {
    if (err) {
      console.error("❌ Failed to send message:", err);
      console.error("Error details:", JSON.stringify(err, null, 2));
    } else {
      console.log("✅ Message sent successfully!", info);
    }
  });
}

function startDailyReset() {
  const PH_OFFSET = 8 * 60 * 60 * 1000;
  
  const now = new Date();
  const utcTime = now.getTime();
  const phTime = utcTime + PH_OFFSET;
  
  const phDate = new Date(phTime);
  const phNextMidnight = new Date(phDate);
  phNextMidnight.setUTCHours(0, 0, 0, 0);
  phNextMidnight.setUTCDate(phNextMidnight.getUTCDate() + 1);
  
  const nextMidnightUTC = phNextMidnight.getTime() - PH_OFFSET;
  const timeUntilMidnight = nextMidnightUTC - utcTime;

  setTimeout(() => {
    performDailyReset();
    
    setInterval(() => {
      performDailyReset();
    }, 24 * 60 * 60 * 1000);
  }, timeUntilMidnight);

  const hours = Math.floor(timeUntilMidnight / 1000 / 60 / 60);
  const minutes = Math.round((timeUntilMidnight / 1000 / 60) % 60);
  const phNow = new Date(phTime);
  console.log(`⏰ Daily reset scheduled for midnight Philippine Time (PHT: ${phNow.toUTCString()}, in ${hours}h ${minutes}m)`);
}

async function performDailyReset() {
  console.log("🔄 Resetting daily attendance...");
  const { usersToKick, usersToWarn } = data.resetDailyAttendance();
  
  if (usersToWarn.length > 0) {
    const warningsByThread = {};
    usersToWarn.forEach(user => {
      if (!warningsByThread[user.threadID]) {
        warningsByThread[user.threadID] = [];
      }
      warningsByThread[user.threadID].push(user);
    });
    
    for (const threadID in warningsByThread) {
      const users = warningsByThread[threadID];
      const threadInfo = await getThreadInfo(threadID);
      
      let warningMessage = `⚠️ ATTENDANCE WARNING ⚠️\n\n`;
      warningMessage += `The following members have 2 consecutive absences and are at risk of being banned:\n\n`;
      
      users.forEach((user, index) => {
        const displayName = threadInfo?.nicknames?.[user.userID] || user.nickname;
        warningMessage += `${index + 1}. ${displayName}\n`;
      });
      
      warningMessage += `\n⚠️ Please use .present consistently to avoid getting banned after 3 consecutive absences!`;
      
      sendMessage(threadID, warningMessage);
      console.log(`⚠️ Sent 2-day absence warning to thread ${threadID} for ${users.length} users`);
    }
  }
  
  if (usersToKick.length > 0) {
    console.log(`⚠️ Found ${usersToKick.length} users to auto-kick for consecutive absences`);
    
    for (const user of usersToKick) {
      if (user.userID === botUserId) {
        console.error("⚠️ CRITICAL: Attempted to auto-kick the bot itself! Skipping...");
        continue;
      }

      const uid = data.banMember(
        user.threadID, 
        user.userID, 
        user.nickname, 
        user.reason,
        "Auto-kick System"
      );
      
      if (uid) {
        sendMessage(
          user.threadID, 
          `🚫 ${user.nickname} has been automatically banned and removed for ${user.reason}.\n\nBan ID: ${uid.uid}\nDuration: ${uid.durationType}\nTo unban: .unban ${uid.uid}`
        );
        
        setTimeout(() => {
          sendMessage(user.threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
          
          setTimeout(() => {
            api.removeUserFromGroup(user.userID, user.threadID, (err) => {
              if (err) {
                console.error(`❌ Failed to remove ${user.nickname} from group:`, err);
                console.log("⚠️ User marked as banned but removal failed - may need manual intervention");
              } else {
                console.log(`✅ Auto-kicked ${user.nickname} from group ${user.threadID}`);
              }
            });
          }, 1000);
        }, 1000);
      }
    }
  }
  
  console.log("✅ Daily reset complete");
}

async function checkAttendanceOnStartup() {
  console.log("🔍 Checking for users with 3+ consecutive absences on startup...");
  
  try {
    const threadList = await new Promise((resolve) => {
      api.getThreadList(25, null, [], (err, list) => {
        if (err) {
          console.error("Failed to get thread list:", err);
          resolve([]);
        } else {
          resolve(list);
        }
      });
    });
    
    console.log(`📋 Found ${threadList.length} threads to check for attendance violations`);
    
    for (const thread of threadList) {
      const threadID = thread.threadID;
      try {
        const threadInfo = await getThreadInfo(threadID);
        if (!threadInfo) {
          console.log(`⚠️ Could not get thread info for ${threadID}, skipping...`);
          continue;
        }
        
        const currentParticipants = new Set(threadInfo.participantIDs || []);
        const attendance = data.getAttendance(threadID, true);
        
        for (const member of attendance.members) {
          if (!member.consecutiveAbsences || member.consecutiveAbsences < 3) {
            continue;
          }
          
          if (isAdmin(threadID, member.userID)) {
            console.log(`✓ Skipping admin ${member.nickname} (${member.userID}) from attendance check`);
            continue;
          }
          
          if (!currentParticipants.has(member.userID)) {
            console.log(`✓ User ${member.nickname} (${member.userID}) already removed from group`);
            continue;
          }
          
          if (data.isBanned(threadID, member.userID)) {
            console.log(`⚠️ User ${member.nickname} is already banned but still in group - attempting removal`);
            api.removeUserFromGroup(member.userID, threadID, (err) => {
              if (err) {
                console.error(`❌ Failed to remove already-banned user ${member.nickname}:`, err);
              } else {
                console.log(`✅ Removed already-banned user ${member.nickname} from group ${threadID}`);
              }
            });
            continue;
          }
          
          console.log(`⚠️ Found user ${member.nickname} with ${member.consecutiveAbsences} consecutive absences still in group - banning and removing`);
          
          const uid = data.banMember(
            threadID,
            member.userID,
            member.nickname,
            `${member.consecutiveAbsences} consecutive days absent (missed while bot was offline)`,
            "Auto-kick System"
          );
          
          if (uid) {
            sendMessage(
              threadID,
              `🚫 ${member.nickname} has been automatically banned and removed for ${member.consecutiveAbsences} consecutive days absent.\n\nBan ID: ${uid.uid}\nDuration: ${uid.durationType}\nTo unban: .unban ${uid.uid}`
            );
            
            setTimeout(() => {
              sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
              
              setTimeout(() => {
                api.removeUserFromGroup(member.userID, threadID, (err) => {
                  if (err) {
                    console.error(`❌ Failed to remove ${member.nickname} from group:`, err);
                  } else {
                    console.log(`✅ Auto-kicked ${member.nickname} from group ${threadID} (startup check)`);
                  }
                });
              }, 1000);
            }, 1000);
          }
        }
      } catch (error) {
        console.error(`Error checking attendance for thread ${threadID}:`, error);
      }
    }
    
    console.log("✅ Attendance startup check complete");
  } catch (error) {
    console.error("Error during attendance startup check:", error);
  }
}

function startPeriodicAppStateSave() {
  setInterval(() => {
    if (api) {
      saveAppState(api.getAppState());
      console.log("🔄 Appstate refreshed");
    }
  }, 60 * 60 * 1000);
  
  console.log("💾 Periodic appstate refresh enabled (every 60 minutes)");
}

async function sendFakeWarningIfEnabled() {
  try {
    const threadList = await new Promise((resolve) => {
      api.getThreadList(10, null, [], (err, list) => {
        if (err) {
          console.error("Failed to get thread list for fake warnings:", err);
          resolve([]);
        } else {
          resolve(list);
        }
      });
    });

    for (const thread of threadList) {
      const threadID = thread.threadID;
      
      if (!data.isFakeWarningEnabled(threadID)) continue;
      if (!data.canSendFakeWarning(threadID)) continue;

      const threadInfo = await getThreadInfo(threadID);
      if (!threadInfo || !threadInfo.participantIDs) continue;

      const eligibleUsers = threadInfo.participantIDs.filter(userID => 
        !isProtectedUser(threadID, userID) && 
        !isAdmin(threadID, userID) &&
        userID !== botUserId
      );

      if (eligibleUsers.length === 0) continue;

      const randomIndex = Math.floor(Math.random() * eligibleUsers.length);
      const targetUserID = eligibleUsers[randomIndex];

      const userInfo = await getUserInfo(targetUserID);
      const nickname = threadInfo.nicknames?.[targetUserID] || userInfo?.name || "User";

      const fakeReasons = [
        "Used vulgar word: \"test\"",
        "Spamming messages",
        "Inappropriate behavior"
      ];
      const randomReason = fakeReasons[Math.floor(Math.random() * fakeReasons.length)];

      const fakeMessage = `⚠️ ${nickname} has been warned!\n\nReason: ${randomReason}\nWarnings: ⛔⛔⛔\n\n❌ User has reached 3 warnings and will be kicked!`;

      api.sendMessage(fakeMessage, threadID, (err, msgInfo) => {
        if (!err && msgInfo) {
          data.recordFakeWarning(threadID, msgInfo.messageID);
          console.log(`🎭 Sent fake warning to ${nickname} in thread ${threadID}`);
          
          setTimeout(() => {
            sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
          }, 2000);
        }
      });

      break;
    }
  } catch (error) {
    console.error("Error in sendFakeWarningIfEnabled:", error);
  }
}

function startPeriodicFakeWarningCheck() {
  setInterval(() => {
    sendFakeWarningIfEnabled();
  }, 60 * 60 * 1000);
  
  console.log("🎭 Periodic fake warning check enabled (every 60 minutes)");
}

function startPeriodicBanCheck() {
  setInterval(() => {
    const liftedBans = data.checkAndLiftExpiredBans();
    if (liftedBans.length > 0) {
      console.log(`⏰ Auto-lifted ${liftedBans.length} expired ban(s)`);
      liftedBans.forEach(({ threadID, nickname }) => {
        sendMessage(threadID, `⏰ ${nickname}'s ban has expired and has been automatically lifted. They can now rejoin the group.`);
      });
    }
  }, 60 * 1000);
  
  console.log("⏰ Periodic ban expiry check enabled (every 1 minute)");
}

async function scanMissedVulgarWords() {
  console.log("🔍 Scanning for missed vulgar words while bot was offline...");
  
  try {
    const threadList = await new Promise((resolve) => {
      api.getThreadList(25, null, [], (err, list) => {
        if (err) {
          console.error("Failed to get thread list:", err);
          resolve([]);
        } else {
          resolve(list);
        }
      });
    });
    
    console.log(`📋 Found ${threadList.length} threads to scan`);
    let totalScanned = 0;
    
    for (const thread of threadList) {
      const threadID = thread.threadID;
      try {
        const threadInfo = await getThreadInfo(threadID);
        if (!threadInfo) {
          console.log(`⚠️ Could not get thread info for ${threadID}, skipping...`);
          continue;
        }
        
        const currentParticipants = new Set(threadInfo.participantIDs || []);
        
        const threadHistory = await new Promise((resolve) => {
          api.getThreadHistory(threadID, 500, null, (err, history) => {
            if (err) {
              console.error(`Failed to get history for thread ${threadID}:`, err);
              resolve([]);
            } else {
              resolve(history);
            }
          });
        });
        
        if (!threadHistory || threadHistory.length === 0) continue;
        
        const warningsAlreadyIssued = data.getAllWarnings(threadID);
        const warnedUserMessageIDs = new Set();
        warningsAlreadyIssued.forEach(w => {
          if (w.reasons) {
            w.reasons.forEach(r => {
              if (r.messageID) warnedUserMessageIDs.add(r.messageID);
            });
          }
        });
        
        for (const message of threadHistory) {
          if (!message.body || !message.senderID) continue;
          if (message.senderID === botUserId) continue;
          if (isProtectedUser(threadID, message.senderID)) continue;
          if (isAdmin(threadID, message.senderID)) continue;
          if (warnedUserMessageIDs.has(message.messageID)) continue;
          
          if (!currentParticipants.has(message.senderID)) {
            continue;
          }
          
          totalScanned++;
          
          const keywords = data.getWarningKeywords(threadID);
          const normalizedMessage = normalizeForDetection(message.body);
          
          for (const keyword of keywords) {
            const normalizedKeyword = normalizeForDetection(keyword);
            const flexPattern = createFlexiblePattern(normalizedKeyword);
            
            if (matchFlexibleKeyword(normalizedMessage, normalizedKeyword, flexPattern)) {
              const userInfo = await getUserInfo(message.senderID);
              const threadInfo = await getThreadInfo(threadID);
              const nickname = threadInfo?.nicknames?.[message.senderID] || userInfo?.name || "User";
              
              console.log(`⚠️ Found missed vulgar word from ${nickname} in thread ${threadID}`);
              
              const previousWarningCount = data.getWarningCount(threadID, message.senderID);
              const warningCount = data.addWarning(threadID, message.senderID, nickname, `[Missed while offline] Used vulgar word: "${keyword}"`, message.messageID);
              
              if (warningCount === previousWarningCount) {
                console.log(`⚠️ Duplicate warning detected for ${nickname}, skipping notification`);
                break;
              }
              
              if (warningCount >= 3) {
                const banReason = `Accumulated 3 warnings`;
                const uid = data.banMember(threadID, message.senderID, nickname, banReason, "System");
                data.clearWarnings(threadID, message.senderID);
                
                sendMessage(threadID, `⚠️ ${nickname} received a warning while the bot was offline!\n\nReason: Used vulgar word: "${keyword}"\n\n❌ User has reached 3 warnings and will be kicked!`);
                
                setTimeout(() => {
                  sendMessage(threadID, `Uy may lumipad HAHAHA\n\nGoodboy ka next time ha HAHA 😂😂`);
                  
                  setTimeout(() => {
                    api.removeUserFromGroup(message.senderID, threadID, (err) => {
                      if (err) {
                        console.error("Failed to remove user from group:", err);
                      } else {
                        console.log(`✅ Kicked ${nickname} for 3 warnings (offline scan)`);
                      }
                    });
                  }, 1000);
                }, 1000);
              } else {
                sendMessage(threadID, `⚠️ ${nickname} received a warning while the bot was offline!\n\nReason: Used vulgar word: "${keyword}"\nWarnings: ${"⛔".repeat(warningCount)}\n\n⚠️ Warning: You will be kicked at 3 warnings!`);
              }
              
              break;
            }
          }
        }
      } catch (error) {
        console.error(`Error scanning thread ${threadID}:`, error);
      }
    }
    
    console.log(`✅ Scan complete. Scanned ${totalScanned} messages.`);
  } catch (error) {
    console.error("Error during missed vulgar words scan:", error);
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 Bot shutting down...");
  if (api) {
    saveAppState(api.getAppState());
    console.log("💾 Session saved for next restart");
  }
  process.exit(0);
});

initializeBot().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
