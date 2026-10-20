export default function Lazy() {
  return <div>{import.meta.env.VITE_TITLE}</div>;
}
