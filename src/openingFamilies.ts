import type { OpeningContext } from './types'

export const openingFamilies: Record<string, OpeningContext> = {
  openGames: {
    familyId: 'open-games', familyName: 'Open Games', confidence: 'structural',
    themes: ['rapid development', 'center control', 'king safety', 'open lines'],
  },
  italian: {
    familyId: 'italian', familyName: 'Italian Game', eco: 'C50', confidence: 'similar',
    themes: ['development', 'f7 pressure', 'king safety', 'central break'],
  },
  sicilian: {
    familyId: 'sicilian', familyName: 'Sicilian Defense', eco: 'B20', confidence: 'similar',
    themes: ['asymmetrical center', 'd4 pressure', 'development', 'open c-file'],
  },
  french: {
    familyId: 'french', familyName: 'French Defense', eco: 'C00', confidence: 'similar',
    themes: ['closed center', 'pawn chains', 'c5 break', 'bad bishop'],
  },
  caroKann: {
    familyId: 'caro-kann', familyName: 'Caro-Kann Defense', eco: 'B10', confidence: 'similar',
    themes: ['solid center', 'light-squared bishop', 'development', 'central breaks'],
  },
  queensPawn: {
    familyId: 'queens-pawn', familyName: "Queen's Pawn Structures", eco: 'D00', confidence: 'similar',
    themes: ['central tension', 'c4 pressure', 'development', 'pawn breaks'],
  },
  hypermodern: {
    familyId: 'hypermodern', familyName: 'Hypermodern Positions', confidence: 'structural',
    themes: ['pressure on the center', 'flexible development', 'pawn breaks'],
  },
}
