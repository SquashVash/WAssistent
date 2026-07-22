# Graph Report - WAssistent  (2026-07-22)

## Corpus Check
- 21 files · ~24,783 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 294 nodes · 759 edges · 10 communities detected
- Extraction: 80% EXTRACTED · 20% INFERRED · 0% AMBIGUOUS · INFERRED: 155 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]

## God Nodes (most connected - your core abstractions)
1. `handleCommand()` - 55 edges
2. `getSetting()` - 24 edges
3. `handleOsintCommand()` - 21 edges
4. `setSetting()` - 21 edges
5. `sendDailyBrief()` - 16 edges
6. `handleSpiderfootCommand()` - 16 edges
7. `handleWatchCommand()` - 15 edges
8. `sendMessage()` - 13 edges
9. `pollOnce()` - 12 edges
10. `handleDMSMessage()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `sendDailyBrief()` --calls--> `generateBriefIntro()`  [INFERRED]
  src\brief.js → src\ai.js
- `checkDueReminders()` --calls--> `humanizeReminder()`  [INFERRED]
  src\reminders.js → src\ai.js
- `handleCommand()` --calls--> `sendFile()`  [INFERRED]
  src\commands.js → src\messaging.js
- `handleIncomingMessage()` --calls--> `getAIReply()`  [INFERRED]
  src\webhook.js → src\ai.js
- `scanForHotelBookingEmails()` --calls--> `extractHotelBooking()`  [INFERRED]
  src\gmail.js → src\ai.js

## Communities

### Community 0 - "Community 0"
Cohesion: 0.12
Nodes (31): getAuthClient(), getUpcomingEvents(), testCalendarConnection(), formatCheckLine(), formatReceiptSourcesList(), formatReceiptsResult(), formatZohoLines(), handleCommand() (+23 more)

### Community 1 - "Community 1"
Cohesion: 0.13
Nodes (35): buildMessage(), dateStr(), fetchAdsb(), fetchAdsbFlight(), fetchAviationStack(), fetchAviationStackFlight(), formatAltitude(), formatHeading() (+27 more)

### Community 2 - "Community 2"
Cohesion: 0.14
Nodes (33): addPending(), buildDataGroups(), buildDossierPDF(), cleanValue(), compileProfile(), detectTargetType(), fetchProfileImage(), finalizeMaigret() (+25 more)

### Community 3 - "Community 3"
Cohesion: 0.17
Nodes (32): addDaysToDateStr(), addRecurringReminder(), addReminder(), advanceRecurrence(), buildTimeStr(), capitalize(), checkDueReminders(), daysInMonth() (+24 more)

### Community 4 - "Community 4"
Cohesion: 0.16
Nodes (30): suggestSupportReply(), advanceFlow(), checkSupportInbox(), checkSupportInboxForScan(), fetchEmail(), getNewUnreadSupportEmails(), getSmtpTransport(), getSupportPollMinutes() (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (27): suggestPriorityTasks(), addOneDay(), buildBirthdaysSection(), buildPaymentsSection(), buildPriorityTaskSection(), buildScheduleSection(), buildTasksSection(), dateStrInTz() (+19 more)

### Community 6 - "Community 6"
Cohesion: 0.17
Nodes (26): addPending(), buildDataGroups(), buildDossierPDF(), cleanValue(), formatScanLine(), formatSummaryTop(), getPending(), getSpiderfootPollMinutes() (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.18
Nodes (20): extractFlightInfo(), extractHotelBooking(), generateBriefIntro(), humanizeReminder(), extractEmailBody(), fetchTicketEmails(), getAuthClient(), getGmailPollMinutes() (+12 more)

### Community 8 - "Community 8"
Cohesion: 0.22
Nodes (16): getAIReply(), clearDMSTimer(), clearSleepTimer(), getConfig(), handleDMSMessage(), handleSetupStep(), initDMS(), parseInterval() (+8 more)

### Community 9 - "Community 9"
Cohesion: 0.21
Nodes (17): cdCreate(), cdDelete(), cdDiff(), cdHistory(), cdList(), cdRecheck(), cdSetPaused(), formatList() (+9 more)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `handleCommand()` connect `Community 0` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 7`, `Community 8`, `Community 9`?**
  _High betweenness centrality (0.479) - this node is a cross-community bridge._
- **Why does `sendDailyBrief()` connect `Community 5` to `Community 0`, `Community 1`, `Community 3`, `Community 7`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **Why does `getSetting()` connect `Community 0` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 9`?**
  _High betweenness centrality (0.143) - this node is a cross-community bridge._
- **Are the 50 inferred relationships involving `handleCommand()` (e.g. with `handleDMSMessage()` and `handleSupportMessage()`) actually correct?**
  _`handleCommand()` has 50 INFERRED edges - model-reasoned connections that need verification._
- **Are the 23 inferred relationships involving `getSetting()` (e.g. with `sendDailyBrief()` and `scheduleDailyBrief()`) actually correct?**
  _`getSetting()` has 23 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `handleOsintCommand()` (e.g. with `handleCommand()` and `sendDocument()`) actually correct?**
  _`handleOsintCommand()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 19 inferred relationships involving `setSetting()` (e.g. with `handleCommand()` and `saveConfig()`) actually correct?**
  _`setSetting()` has 19 INFERRED edges - model-reasoned connections that need verification._