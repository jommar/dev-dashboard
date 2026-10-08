import { createTheme } from '@mui/material/styles';

export const dashboardTheme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#111113', paper: '#1c1d20' },
    primary: { main: '#67e8f9' },
    success: { main: '#34d399' },
    error: { main: '#fb7185' },
    warning: { main: '#fbbf24' },
    text: { primary: '#edeef0', secondary: '#949aa3' },
    divider: '#2e3035',
  },
  typography: {
    fontFamily: '"Inter Tight", system-ui, -apple-system, "Segoe UI", sans-serif',
    button: { textTransform: 'none', fontWeight: 500 },
  },
  shape: { borderRadius: 6 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { minHeight: 36, borderRadius: 6 } },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12, maxWidth: 320 } } },
  },
});
