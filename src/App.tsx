// Preview harness: shows the QROS dapp (qrossbridge/dapp) full-bleed. The dapp itself is plain HTML/CSS/JS.
export default function App() {
  return (
    <iframe
      title="QROS Bridge"
      src="/dapp/tetrix-bridge.html"
      className="fixed inset-0 h-full w-full border-0"
      allow="clipboard-write"
    />
  )
}
