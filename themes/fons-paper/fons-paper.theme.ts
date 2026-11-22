// The fons-paper theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in fons-paper.settings.json and the generated fons-paper.settings.ts;
// change them with `astryx experimental theme editor set fons-paper ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {fonsPaperSettings} from './fons-paper.settings';

export const fonsPaperTheme = defineTheme({
  extends: fonsPaperSettings,
  name: 'fons-paper',
});
