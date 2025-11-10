# Facebook Messenger Attendance Bot

A Facebook Messenger bot for tracking daily attendance in group chats with customizable greetings and automatic member management.

## Features

- ✅ **Automatic Login**: Uses appstate/cookies for persistent authentication
- 👋 **Custom Greetings**: Welcome new members with personalized messages (admin-only modification)
- 📋 **Daily Attendance**: Track who's present each day with automatic reset at midnight
- ✅ **Check-in System**: Simple `.present` command to mark attendance
- 🔒 **Duplicate Prevention**: Prevents multiple check-ins per day
- 💾 **Persistent Storage**: All data saved across bot restarts
- 🔄 **Auto Member Detection**: Automatically adds new group members to attendance list

## Setup Instructions

### Step 1: Get Your Facebook Appstate

**⚠️ IMPORTANT:** You need **FRESH** Facebook session cookies for the bot to work properly.

**📖 [Read the detailed step-by-step guide: HOW_TO_GET_APPSTATE.md](HOW_TO_GET_APPSTATE.md)**

**Quick Steps:**

1. **Install a browser extension** to extract cookies:
   - Chrome/Edge: "EditThisCookie" or "Cookie-Editor"
   - Firefox: "Cookie-Editor"

2. **Login to Facebook** in your browser with the account you want to use for the bot

3. **Export the cookies**:
   - Click the extension icon
   - Click "Export" and copy to clipboard

4. **Create appstate.json**:
   - Create a file named `appstate.json` in the project root
   - Paste your cookies into it (should be a JSON array)

**💡 Tip:** Use Firefox for longer-lasting sessions and always get fresh cookies right after logging in!

### Step 2: Run the Bot

Once you have `appstate.json` set up:

```bash
npm start
```

The bot will:
- Login using your appstate
- Save the session for future use
- Start listening for messages and events
- Schedule daily attendance reset at midnight

## Commands

### For All Users

- `.present` - Mark yourself as present for today's attendance
- `.attendance` - View the current day's attendance list

### For Group Admins Only

- `.setgreeting [message]` - Set a custom greeting for new members
  - Use `{name}` as a placeholder for the new member's name
  - Example: `.setgreeting Welcome {name}! Please read the group rules! 📜`

## How It Works

### Attendance Tracking

1. When someone joins the group, they're automatically added to the attendance list
2. Members can mark themselves present using `.present`
3. Each member can only mark present once per day
4. Attendance automatically resets at midnight
5. View attendance anytime with `.attendance`

### Greeting System

- Default greeting: "Welcome {name} to the group! 👋"
- Only group admins can change the greeting using `.setgreeting`
- Greeting applies to all new members added to the group
- Each group can have its own custom greeting

### Data Persistence

All data is stored in JSON files:
- `appstate.json` - Your Facebook session (keep this secure!)
- `data/greetings.json` - Custom greetings per group
- `data/attendance.json` - Attendance records per group

## Security Notes

- **Never share your `appstate.json`** - it contains your Facebook session
- The bot can only access groups where the logged-in account is a member
- Keep the bot account secure (use a dedicated Facebook account if possible)
- Appstate is automatically updated and saved when the bot runs

## Troubleshooting

### "Not logged in" or Error 1357004

This is the most common issue and means your cookies are **expired or invalid**.

**Solution:**
1. Open Facebook in your browser and login
2. Complete any security checks or verifications
3. Use the cookie extension to export **FRESH** cookies
4. Replace the content of `appstate.json` with the new cookies
5. Restart the bot

**See [HOW_TO_GET_APPSTATE.md](HOW_TO_GET_APPSTATE.md) for detailed troubleshooting.**

### Account security checks

If Facebook asks for verification:
- Complete all security challenges
- Approve any "unrecognized login" alerts
- The bot uses `forceLogin: true` to auto-approve most alerts
- Consider using a dedicated Facebook account for the bot

### Bot not responding

- Make sure the bot is running (`npm start`)
- Check that the bot account is in the group chat
- Verify the commands are typed correctly (case-sensitive)
- Check console logs for errors

### Daily reset not working

- The bot schedules reset at midnight (00:00) in the server's timezone
- Keep the bot running continuously for automatic resets
- Manual restart will reschedule the next reset

## Support

If you encounter issues:
1. Check the console logs for error messages
2. Verify your appstate.json is up to date
3. Ensure all dependencies are installed (`npm install`)
4. Try getting a fresh appstate from Facebook
