#ifndef STREMIO_DISCORD_H
#define STREMIO_DISCORD_H

#include <string>
#include <vector>

void InitializeDiscord();
void SetDiscordPresenceFromArgs(const std::vector<std::string>& args);
// Used by the official web bundle's discord-set-activity / -clear-activity.
void SetDiscordActivityFromJson(const std::string& payload);
void ClearDiscordActivity();

#endif
