import { createTheme } from '@mui/material/styles';

export const dashboardTheme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0a0b0d', paper: '#181b20' },
    primary: { main: '#67e8f9' },
    success: { main: '#34d399' },
    error: { main: '#fc7a8d' },
    warning: { main: '#fbbf24' },
    text: { primary: '#f1f2f4', secondary: '#a1a8b2' },
    divider: '#363c46',
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
