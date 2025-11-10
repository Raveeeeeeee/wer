const fs = require("fs");
const path = require("path");

class DataManager {
  constructor() {
    this.dataDir = path.join(__dirname, "data");
    this.greetingsFile = path.join(this.dataDir, "greetings.json");
    this.attendanceFile = path.join(this.dataDir, "attendance.json");
    this.bannedFile = path.join(this.dataDir, "banned.json");
    this.warningsFile = path.join(this.dataDir, "warnings.json");
    this.warningKeywordsFile = path.join(this.dataDir, "warningKeywords.json");
    this.excludedFile = path.join(this.dataDir, "excluded.json");
    this.adminsFile = path.join(this.dataDir, "admins.json");
    this.serverInfoFile = path.join(this.dataDir, "serverInfo.json");
    this.warExtremeFile = path.join(this.dataDir, "warExtreme.json");
    this.banCountFile = path.join(this.dataDir, "banCount.json");
    this.fakeWarningsFile = path.join(this.dataDir, "fakeWarnings.json");
    this.kickCountFile = path.join(this.dataDir, "kickCount.json");
    this.memberJoinDatesFile = path.join(this.dataDir, "memberJoinDates.json");
    
    this.ensureDataDir();
    this.greetings = this.loadJSON(this.greetingsFile, {});
    this.attendance = this.loadJSON(this.attendanceFile, {});
    this.banned = this.loadJSON(this.bannedFile, {});
    this.warnings = this.loadJSON(this.warningsFile, {});
    this.warningKeywords = this.loadJSON(this.warningKeywordsFile, {
      global: []
    });
    this.excluded = this.loadJSON(this.excludedFile, {});
    this.admins = this.loadJSON(this.adminsFile, {});
    this.serverInfo = this.loadJSON(this.serverInfoFile, {});
    this.warExtreme = this.loadJSON(this.warExtremeFile, {});
    this.banCount = this.loadJSON(this.banCountFile, {});
    this.fakeWarnings = this.loadJSON(this.fakeWarningsFile, {});
    this.kickCount = this.loadJSON(this.kickCountFile, {});
    this.memberJoinDates = this.loadJSON(this.memberJoinDatesFile, {});
    
    this.messageCache = new Map();
    
    this.globalAdminIDs = [];
    this.protectedUserIDs = [];
  }
  
  setGlobalAdmins(adminIDs, protectedIDs) {
    this.globalAdminIDs = adminIDs || [];
    this.protectedUserIDs = protectedIDs || [];
  }
  
  isAdminUser(threadID, userID) {
    if (this.protectedUserIDs.includes(userID)) {
      return true;
    }
    
    if (this.globalAdminIDs.includes(userID)) {
      return true;
    }
    
    const groupAdmins = this.getGroupAdmins(threadID);
    return groupAdmins.includes(userID);
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadJSON(filePath, defaultValue) {
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return data;
      }
    } catch (error) {
      console.error(`Failed to load ${filePath}:`, error.message);
    }
    return defaultValue;
  }

  saveJSON(filePath, data) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`Failed to save ${filePath}:`, error.message);
    }
  }

  getGreeting(threadID) {
    return this.greetings[threadID] || "Welcome {name} to the group! 👋";
  }

  setGreeting(threadID, greeting) {
    this.greetings[threadID] = greeting;
    this.saveJSON(this.greetingsFile, this.greetings);
  }

  getAttendance(threadID, includeExcluded = false) {
    const today = this.getTodayDate();
    
    if (!this.attendance[threadID]) {
      this.attendance[threadID] = {
        date: today,
        members: []
      };
    }

    if (this.attendance[threadID].date !== today) {
      this.attendance[threadID].date = today;
      this.attendance[threadID].members.forEach(member => {
        member.present = false;
      });
      this.saveJSON(this.attendanceFile, this.attendance);
    }

    if (includeExcluded) {
      return this.attendance[threadID];
    }

    const excludedUsers = this.getExcludedMembers(threadID);
    const filteredAttendance = {
      ...this.attendance[threadID],
      members: this.attendance[threadID].members.filter(m => 
        !excludedUsers.includes(m.userID) && !this.isAdminUser(threadID, m.userID)
      )
    };

    return filteredAttendance;
  }

  addMember(threadID, userID, nickname) {
    const attendance = this.getAttendance(threadID, true);
    
    const existingMember = attendance.members.find(m => m.userID === userID);
    
    if (existingMember) {
      if (existingMember.nickname !== nickname) {
        existingMember.nickname = nickname;
        this.saveJSON(this.attendanceFile, this.attendance);
      }
    } else {
      attendance.members.push({
        userID,
        nickname,
        present: false,
        consecutiveAbsences: 0
      });
      this.saveJSON(this.attendanceFile, this.attendance);
    }
  }

  removeMember(threadID, userID) {
    if (!this.attendance[threadID]) {
      return null;
    }
    
    const memberIndex = this.attendance[threadID].members.findIndex(m => m.userID === userID);
    
    if (memberIndex !== -1) {
      const removedMember = this.attendance[threadID].members[memberIndex];
      this.attendance[threadID].members.splice(memberIndex, 1);
      this.saveJSON(this.attendanceFile, this.attendance);
      console.log(`✅ Removed ${removedMember.nickname} from attendance list in thread ${threadID}`);
      return removedMember;
    }
    return null;
  }

  markPresent(threadID, userID, nickname) {
    const attendance = this.getAttendance(threadID, true);
    
    let member = attendance.members.find(m => m.userID === userID);
    
    if (!member) {
      member = {
        userID,
        nickname,
        present: false,
        consecutiveAbsences: 0
      };
      attendance.members.push(member);
    }

    if (member.nickname !== nickname) {
      member.nickname = nickname;
    }

    if (member.present) {
      return true;
    }

    member.present = true;
    member.consecutiveAbsences = 0;
    this.saveJSON(this.attendanceFile, this.attendance);
    return false;
  }

  getMissedAttendanceList(threadID) {
    const attendance = this.getAttendance(threadID);
    const excludedUsers = this.getExcludedMembers(threadID);
    
    const missedList = attendance.members
      .filter(m => !m.present && !excludedUsers.includes(m.userID) && !this.isAdminUser(threadID, m.userID))
      .map(m => ({
        userID: m.userID,
        nickname: m.nickname,
        consecutiveAbsences: m.consecutiveAbsences || 0
      }))
      .sort((a, b) => b.consecutiveAbsences - a.consecutiveAbsences);
    
    return missedList;
  }

  manualResetAttendance(threadID) {
    const today = this.getTodayDate();
    
    if (!this.attendance[threadID]) {
      return false;
    }

    this.attendance[threadID].date = today;
    this.attendance[threadID].members.forEach(member => {
      member.present = false;
    });
    
    this.saveJSON(this.attendanceFile, this.attendance);
    return true;
  }

  resetConsecutiveAbsences(threadID, userID = null) {
    if (!this.attendance[threadID]) {
      return false;
    }

    if (userID) {
      const member = this.attendance[threadID].members.find(m => m.userID === userID);
      if (!member) {
        return false;
      }
      member.consecutiveAbsences = 0;
    } else {
      this.attendance[threadID].members.forEach(member => {
        member.consecutiveAbsences = 0;
      });
    }
    
    this.saveJSON(this.attendanceFile, this.attendance);
    return true;
  }

  resetDailyAttendance() {
    const today = this.getTodayDate();
    const usersToKick = [];
    const usersToWarn = [];
    
    for (const threadID in this.attendance) {
      this.attendance[threadID].date = today;
      this.attendance[threadID].members.forEach(member => {
        if (this.isAdminUser(threadID, member.userID)) {
          member.present = false;
          return;
        }
        
        if (!member.present) {
          member.consecutiveAbsences = (member.consecutiveAbsences || 0) + 1;
          
          if (member.consecutiveAbsences >= 3) {
            usersToKick.push({
              threadID,
              userID: member.userID,
              nickname: member.nickname,
              reason: `3 consecutive days absent (${member.consecutiveAbsences} days)`
            });
          } else if (member.consecutiveAbsences === 2) {
            usersToWarn.push({
              threadID,
              userID: member.userID,
              nickname: member.nickname
            });
          }
        }
        member.present = false;
      });
    }
    
    this.saveJSON(this.attendanceFile, this.attendance);
    return { usersToKick, usersToWarn };
  }

  getBanCount(threadID, userID) {
    const key = `${threadID}_${userID}`;
    return this.banCount[key] || 0;
  }

  incrementBanCount(threadID, userID) {
    const key = `${threadID}_${userID}`;
    this.banCount[key] = (this.banCount[key] || 0) + 1;
    this.saveJSON(this.banCountFile, this.banCount);
    return this.banCount[key];
  }

  resetBanCount(threadID, userID) {
    const key = `${threadID}_${userID}`;
    if (this.banCount[key]) {
      delete this.banCount[key];
      this.saveJSON(this.banCountFile, this.banCount);
      return true;
    }
    return false;
  }

  banMember(threadID, userID, nickname, reason, bannedBy) {
    if (!this.banned[threadID]) {
      this.banned[threadID] = [];
    }

    const existingBan = this.banned[threadID].find(b => b.userID === userID);
    if (existingBan) {
      return false;
    }

    const uid = this.generateUniqueUID(threadID);
    const banCount = this.incrementBanCount(threadID, userID);
    
    let durationDays = 0;
    let durationType = "";
    let liftDate = null;
    
    if (banCount === 1) {
      durationDays = 3;
      durationType = "3 days";
      liftDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    } else if (banCount === 2) {
      durationDays = 7;
      durationType = "7 days";
      liftDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else {
      durationType = "permanent";
      liftDate = null;
    }

    this.banned[threadID].push({
      uid,
      userID,
      nickname,
      reason,
      bannedBy,
      date: new Date().toISOString(),
      banCount,
      durationType,
      liftDate
    });

    if (this.attendance[threadID]) {
      const memberIndex = this.attendance[threadID].members.findIndex(m => m.userID === userID);
      if (memberIndex !== -1) {
        this.attendance[threadID].members.splice(memberIndex, 1);
      }
    }

    this.saveJSON(this.bannedFile, this.banned);
    this.saveJSON(this.attendanceFile, this.attendance);
    return { uid, durationType, liftDate };
  }

  unbanMember(threadID, identifier) {
    if (!this.banned[threadID]) {
      return null;
    }

    let bannedMember = null;
    let banIndex = -1;

    if (identifier.length === 6) {
      banIndex = this.banned[threadID].findIndex(b => b.uid === identifier);
    } else {
      banIndex = this.banned[threadID].findIndex(b => b.userID === identifier);
    }

    if (banIndex === -1) {
      return null;
    }

    bannedMember = this.banned[threadID][banIndex];
    this.banned[threadID].splice(banIndex, 1);
    this.saveJSON(this.bannedFile, this.banned);
    
    return bannedMember;
  }

  saveAdminList(admins) {
    const adminFile = path.join(this.dataDir, "admins.json");
    this.saveJSON(adminFile, admins);
  }

  loadAdminList() {
    const adminFile = path.join(this.dataDir, "globalAdmins.json");
    return this.loadJSON(adminFile, []);
  }

  isBanned(threadID, userID) {
    if (!this.banned[threadID]) {
      return false;
    }
    return this.banned[threadID].some(b => b.userID === userID);
  }

  getBannedMembers(threadID) {
    return this.banned[threadID] || [];
  }

  generateUID() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let uid = '';
    for (let i = 0; i < 6; i++) {
      uid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return uid;
  }

  generateUniqueUID(threadID) {
    let uid = this.generateUID();
    let attempts = 0;
    const maxAttempts = 100;

    if (!this.banned[threadID]) {
      return uid;
    }

    while (this.banned[threadID].some(b => b.uid === uid) && attempts < maxAttempts) {
      uid = this.generateUID();
      attempts++;
    }

    if (attempts >= maxAttempts) {
      uid = `${uid}${Date.now().toString().slice(-3)}`;
    }

    return uid;
  }

  getTodayDate() {
    const PH_OFFSET = 8 * 60 * 60 * 1000;
    const now = new Date();
    const phTime = new Date(now.getTime() + PH_OFFSET);
    return phTime.toLocaleDateString('en-US', { timeZone: 'UTC' });
  }

  generateWarningKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let key = '';
    for (let i = 0; i < 24; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
  }

  addWarning(threadID, userID, nickname, reason, messageID = null, isPermanent = false) {
    if (!this.warnings[threadID]) {
      this.warnings[threadID] = {};
    }

    if (!this.warnings[threadID][userID]) {
      this.warnings[threadID][userID] = {
        nickname,
        count: 0,
        reasons: []
      };
    }

    const warningKey = this.generateWarningKey();
    const now = new Date();
    const phTime = now.toLocaleString('en-US', { 
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const timestamp = now.getTime();
    
    const existingWarning = this.warnings[threadID][userID].reasons.find(r => {
      if (messageID && r.messageID === messageID) {
        return true;
      }
      if (r.timestamp && Math.abs(timestamp - r.timestamp) < 2000) {
        return true;
      }
      return false;
    });
    
    if (existingWarning) {
      console.log(`⚠️ Duplicate warning detected (messageID: ${messageID}, timestamp: ${phTime}), skipping...`);
      return this.warnings[threadID][userID].count;
    }

    this.warnings[threadID][userID].count++;
    this.warnings[threadID][userID].reasons.push({
      key: warningKey,
      reason,
      date: phTime,
      timestamp: timestamp,
      messageID: messageID,
      permanent: isPermanent || false
    });
    
    if (isPermanent) {
      console.log(`🔒 Permanent warning added for user ${userID} at ${phTime}`);
    }
    
    this.warnings[threadID][userID].nickname = nickname;
    this.saveJSON(this.warningsFile, this.warnings);
    return this.warnings[threadID][userID].count;
  }

  getWarningCount(threadID, userID) {
    if (!this.warnings[threadID] || !this.warnings[threadID][userID]) {
      return 0;
    }
    return this.warnings[threadID][userID].count;
  }

  getAllWarnings(threadID) {
    if (!this.warnings[threadID]) {
      return [];
    }

    const warningList = [];
    for (const userID in this.warnings[threadID]) {
      const userData = this.warnings[threadID][userID];
      warningList.push({
        userID,
        nickname: userData.nickname,
        count: userData.count,
        reasons: userData.reasons
      });
    }

    warningList.sort((a, b) => b.count - a.count);
    return warningList;
  }

  clearWarnings(threadID, userID) {
    if (this.warnings[threadID] && this.warnings[threadID][userID]) {
      delete this.warnings[threadID][userID];
      this.saveJSON(this.warningsFile, this.warnings);
    }
  }

  deductWarning(threadID, userID, canRemovePermanent = false) {
    if (!this.warnings[threadID] || !this.warnings[threadID][userID]) {
      return 0;
    }

    const userData = this.warnings[threadID][userID];
    
    if (userData.count > 0 && userData.reasons.length > 0) {
      let removedIndex = -1;
      
      for (let i = userData.reasons.length - 1; i >= 0; i--) {
        if (!userData.reasons[i].permanent || canRemovePermanent) {
          removedIndex = i;
          break;
        }
      }
      
      if (removedIndex === -1) {
        console.log(`⚠️ Cannot remove warnings for user ${userID} - all warnings are permanent`);
        return userData.count;
      }
      
      userData.reasons.splice(removedIndex, 1);
      userData.count--;
      
      const newCount = userData.count;
      
      if (newCount === 0) {
        delete this.warnings[threadID][userID];
      }
      
      this.saveJSON(this.warningsFile, this.warnings);
      return newCount;
    }

    return userData.count;
  }

  getWarningKeywords(threadID) {
    const globalKeywords = this.warningKeywords.global || [];
    const threadKeywords = this.warningKeywords[threadID] || [];
    return [...globalKeywords, ...threadKeywords];
  }

  addWarningKeyword(threadID, keyword) {
    if (!this.warningKeywords[threadID]) {
      this.warningKeywords[threadID] = [];
    }

    const lowerKeyword = keyword.toLowerCase();
    
    if (this.warningKeywords.global.includes(lowerKeyword) || 
        this.warningKeywords[threadID].includes(lowerKeyword)) {
      return false;
    }

    this.warningKeywords[threadID].push(lowerKeyword);
    this.saveJSON(this.warningKeywordsFile, this.warningKeywords);
    return true;
  }

  addWarningKeywords(threadID, keywords) {
    const added = [];
    const skipped = [];
    
    for (const keyword of keywords) {
      const success = this.addWarningKeyword(threadID, keyword);
      if (success) {
        added.push(keyword);
      } else {
        skipped.push(keyword);
      }
    }
    
    return { added, skipped };
  }

  syncGroupMembers(threadID, currentMemberIDs, botUserId, recentlyAddedUserIDs = []) {
    if (!this.attendance[threadID]) {
      return { removed: [] };
    }

    const removed = [];
    const currentMembers = this.attendance[threadID].members.filter(member => {
      if (member.userID === botUserId) {
        removed.push(member);
        return false;
      }
      if (recentlyAddedUserIDs.includes(member.userID)) {
        return true;
      }
      if (!currentMemberIDs.includes(member.userID)) {
        removed.push(member);
        return false;
      }
      return true;
    });

    this.attendance[threadID].members = currentMembers;
    
    if (removed.length > 0) {
      this.saveJSON(this.attendanceFile, this.attendance);
    }

    return { removed };
  }

  getExcludedMembers(threadID) {
    return this.excluded[threadID] || [];
  }

  excludeMember(threadID, userID, nickname) {
    if (!this.excluded[threadID]) {
      this.excluded[threadID] = [];
    }

    const alreadyExcluded = this.excluded[threadID].some(m => m.userID === userID);
    if (alreadyExcluded) {
      return false;
    }

    this.excluded[threadID].push({
      userID,
      nickname,
      excludedDate: new Date().toISOString()
    });

    this.saveJSON(this.excludedFile, this.excluded);
    return true;
  }

  includeMember(threadID, userID) {
    if (!this.excluded[threadID]) {
      return null;
    }

    const memberIndex = this.excluded[threadID].findIndex(m => m.userID === userID);
    if (memberIndex === -1) {
      return null;
    }

    const member = this.excluded[threadID][memberIndex];
    this.excluded[threadID].splice(memberIndex, 1);

    if (this.excluded[threadID].length === 0) {
      delete this.excluded[threadID];
    }

    this.saveJSON(this.excludedFile, this.excluded);
    return member;
  }

  isExcluded(threadID, userID) {
    if (!this.excluded[threadID]) {
      return false;
    }
    return this.excluded[threadID].some(m => m.userID === userID);
  }

  cacheMessage(messageID, threadID, senderID, body, attachments = []) {
    const cacheData = {
      messageID,
      threadID,
      senderID,
      body: body || "",
      attachments,
      timestamp: Date.now()
    };
    
    this.messageCache.set(messageID, cacheData);
    
    setTimeout(() => {
      this.messageCache.delete(messageID);
    }, 60000);
  }

  getCachedMessage(messageID) {
    return this.messageCache.get(messageID);
  }

  getGroupAdmins(threadID) {
    if (!this.admins[threadID]) {
      return [];
    }
    return this.admins[threadID];
  }

  addGroupAdmin(threadID, userID) {
    if (!this.admins[threadID]) {
      this.admins[threadID] = [];
    }
    
    if (this.admins[threadID].includes(userID)) {
      return false;
    }
    
    this.admins[threadID].push(userID);
    this.saveJSON(this.adminsFile, this.admins);
    return true;
  }

  removeGroupAdmin(threadID, userID) {
    if (!this.admins[threadID]) {
      return false;
    }
    
    const index = this.admins[threadID].indexOf(userID);
    if (index === -1) {
      return false;
    }
    
    this.admins[threadID].splice(index, 1);
    
    if (this.admins[threadID].length === 0) {
      delete this.admins[threadID];
    }
    
    this.saveJSON(this.adminsFile, this.admins);
    return true;
  }

  isGroupAdmin(threadID, userID) {
    if (!this.admins[threadID]) {
      return false;
    }
    return this.admins[threadID].includes(userID);
  }

  removeWarningKeyword(threadID, keyword) {
    if (!this.warningKeywords[threadID]) {
      return false;
    }

    const lowerKeyword = keyword.toLowerCase();
    const index = this.warningKeywords[threadID].indexOf(lowerKeyword);
    
    if (index === -1) {
      return false;
    }

    this.warningKeywords[threadID].splice(index, 1);
    
    if (this.warningKeywords[threadID].length === 0) {
      delete this.warningKeywords[threadID];
    }
    
    this.saveJSON(this.warningKeywordsFile, this.warningKeywords);
    return true;
  }

  removeWarningKeywords(threadID, keywords) {
    const removed = [];
    const notFound = [];
    
    for (const keyword of keywords) {
      const success = this.removeWarningKeyword(threadID, keyword);
      if (success) {
        removed.push(keyword);
      } else {
        notFound.push(keyword);
      }
    }
    
    return { removed, notFound };
  }

  getServerInfo(threadID) {
    return this.serverInfo[threadID] || null;
  }

  setServerInfo(threadID, info) {
    this.serverInfo[threadID] = info;
    this.saveJSON(this.serverInfoFile, this.serverInfo);
  }

  isWarExtremeMode(threadID) {
    return this.warExtreme[threadID] === true;
  }

  setWarExtremeMode(threadID, enabled) {
    if (enabled) {
      this.warExtreme[threadID] = true;
    } else {
      delete this.warExtreme[threadID];
    }
    this.saveJSON(this.warExtremeFile, this.warExtreme);
  }

  checkAndLiftExpiredBans() {
    const now = new Date();
    const liftedBans = [];

    for (const threadID in this.banned) {
      if (!this.banned[threadID]) continue;

      const expiredBans = this.banned[threadID].filter(ban => {
        return ban.liftDate && new Date(ban.liftDate) <= now;
      });

      for (const ban of expiredBans) {
        const unbanned = this.unbanMember(threadID, ban.uid);
        if (unbanned) {
          liftedBans.push({ threadID, ...unbanned });
        }
      }
    }

    return liftedBans;
  }

  removeAllBans(threadID) {
    if (!this.banned[threadID]) {
      return { count: 0 };
    }

    const count = this.banned[threadID].length;
    
    for (const ban of this.banned[threadID]) {
      const key = `${threadID}_${ban.userID}`;
      this.banCount[key] = 0;
    }
    
    delete this.banned[threadID];
    
    this.saveJSON(this.bannedFile, this.banned);
    this.saveJSON(this.banCountFile, this.banCount);
    
    return { count };
  }

  removeAllWarnings(threadID) {
    if (!this.warnings[threadID]) {
      return { count: 0 };
    }

    const count = Object.keys(this.warnings[threadID]).length;
    
    delete this.warnings[threadID];
    
    this.saveJSON(this.warningsFile, this.warnings);
    
    return { count };
  }

  isFakeWarningEnabled(threadID) {
    return this.fakeWarnings[threadID]?.enabled === true;
  }

  toggleFakeWarning(threadID) {
    if (!this.fakeWarnings[threadID]) {
      this.fakeWarnings[threadID] = { enabled: false, monthlyCount: 0, lastReset: new Date().toISOString() };
    }
    this.fakeWarnings[threadID].enabled = !this.fakeWarnings[threadID].enabled;
    this.saveJSON(this.fakeWarningsFile, this.fakeWarnings);
    return this.fakeWarnings[threadID].enabled;
  }

  canSendFakeWarning(threadID) {
    if (!this.fakeWarnings[threadID]) {
      this.fakeWarnings[threadID] = { enabled: false, monthlyCount: 0, lastReset: new Date().toISOString() };
      this.saveJSON(this.fakeWarningsFile, this.fakeWarnings);
    }
    
    const now = new Date();
    const lastReset = new Date(this.fakeWarnings[threadID].lastReset);
    
    if (now.getMonth() !== lastReset.getMonth() || now.getFullYear() !== lastReset.getFullYear()) {
      this.fakeWarnings[threadID].monthlyCount = 0;
      this.fakeWarnings[threadID].lastReset = now.toISOString();
      this.saveJSON(this.fakeWarningsFile, this.fakeWarnings);
    }
    
    return this.fakeWarnings[threadID].monthlyCount < 2;
  }

  recordFakeWarning(threadID, messageID) {
    if (!this.fakeWarnings[threadID]) {
      this.fakeWarnings[threadID] = { enabled: false, monthlyCount: 0, lastReset: new Date().toISOString(), pending: {} };
    }
    if (!this.fakeWarnings[threadID].pending) {
      this.fakeWarnings[threadID].pending = {};
    }
    this.fakeWarnings[threadID].monthlyCount++;
    this.fakeWarnings[threadID].pending[messageID] = Date.now();
    this.saveJSON(this.fakeWarningsFile, this.fakeWarnings);
  }

  isFakeWarningMessage(threadID, messageID) {
    if (!this.fakeWarnings[threadID] || !this.fakeWarnings[threadID].pending) {
      return false;
    }
    return this.fakeWarnings[threadID].pending[messageID] !== undefined;
  }

  removeFakeWarningMessage(threadID, messageID) {
    if (this.fakeWarnings[threadID] && this.fakeWarnings[threadID].pending) {
      delete this.fakeWarnings[threadID].pending[messageID];
      this.saveJSON(this.fakeWarningsFile, this.fakeWarnings);
    }
  }

  incrementKickCount(threadID, userID) {
    const key = `${threadID}_${userID}`;
    if (!this.kickCount[key]) {
      this.kickCount[key] = 0;
    }
    this.kickCount[key]++;
    this.saveJSON(this.kickCountFile, this.kickCount);
    return this.kickCount[key];
  }

  getKickCount(threadID, userID) {
    const key = `${threadID}_${userID}`;
    return this.kickCount[key] || 0;
  }

  setMemberJoinDate(threadID, userID, date) {
    const key = `${threadID}_${userID}`;
    if (!this.memberJoinDates[key]) {
      this.memberJoinDates[key] = date || new Date().toISOString();
      this.saveJSON(this.memberJoinDatesFile, this.memberJoinDates);
    }
  }

  getMemberJoinDate(threadID, userID) {
    const key = `${threadID}_${userID}`;
    return this.memberJoinDates[key];
  }
}

module.exports = DataManager;
