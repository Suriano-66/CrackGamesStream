// Registre des jeux embarqués dans l'app Streamer.
// Un jeu = un fichier moteur + une entrée ici. Rien d'autre à modifier.
import { createMarbleRace3D } from "./marbleRaceEngine.js";
import { createTeamWar3D } from "./teamWarEngine.js";

export const GAMES = {
  "marble-race": {
    id: "marble-race",
    title: "🏁 La grande course",
    cta: "🎁 Offre un cadeau pour lâcher tes billes !",
    create: createMarbleRace3D,
    cameras: [
      ["auto", "Auto"],
      ["chase", "Derrière"],
      ["front", "De face"],
      ["side", "Côté"],
      ["top", "Vue du haut"],
      ["free", "🎮 Libre"],
    ],
  },
  "team-war": {
    id: "team-war",
    title: "⚔️ Rouge vs Bleu",
    cta: "🎁 Un cadeau = des combattants pour ton camp !",
    create: createTeamWar3D,
    cameras: [
      ["auto", "Auto"],
      ["side", "Côté"],
      ["close", "Mêlée"],
      ["front", "Dans l'axe"],
      ["high", "Vue haute"],
      ["top", "Dessus"],
      ["free", "🎮 Libre"],
    ],
  },
};

export const DEFAULT_GAME = "marble-race";
export function getGame(id) {
  return GAMES[id] || GAMES[DEFAULT_GAME];
}
