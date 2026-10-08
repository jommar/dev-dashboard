export function Markup({ children, as: Component = 'div', ...props }) {
  return <Component {...props}>{children}</Component>;
}
