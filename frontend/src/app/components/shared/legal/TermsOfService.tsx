export default function TermsOfService() {
  return (
    <>
      <p>By using PinTool you agree to these terms. If you do not agree, do not use the service.</p>

      <h2>1. Nature of the service</h2>
      <p>PinTool is a non-custodial interface. Strategy Providers describe market-making strategies; Makers choose a strategy and set their own limits. PinTool never holds your funds or your private keys. Every transaction that moves your tokens is signed by you in your own wallet.</p>

      <h2>2. Risks and third-party dependencies</h2>
      <ul>
        <li><strong>Market risk.</strong> Providing liquidity can lose money. Prices move, pegged assets can lose their peg, and fees do not guarantee a profit.</li>
        <li><strong>Limits are constraints, not guarantees.</strong> Risk limits reduce exposure but do not guarantee a maximum loss.</li>
        <li><strong>Public execution.</strong> Parameters of an activated strategy and its trades are visible onchain.</li>
        <li><strong>Third parties.</strong> PinTool depends on 1inch Aqua, Chainlink, Privy, blockchains and their infrastructure. Their failures, changes or downtime are outside our control.</li>
        <li><strong>Smart contract risk.</strong> Contracts may contain bugs despite testing.</li>
      </ul>

      <h2>3. Your responsibilities</h2>
      <ul>
        <li>Review every transaction before you sign it.</li>
        <li>Keep your wallet, seed phrase and login secure.</li>
        <li>Make sure your use of PinTool is legal where you live.</li>
        <li>Strategy Providers are responsible for the accuracy of their public descriptions.</li>
      </ul>

      <h2>4. No financial advice</h2>
      <p>Nothing in PinTool is investment, financial or legal advice. Strategy templates and listings describe mechanisms; they are not recommendations or performance promises.</p>

      <h2>5. Disclaimer of warranties</h2>
      <p>PinTool is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind.</p>

      <h2>6. Limitation of liability</h2>
      <p>To the fullest extent permitted by law, PinTool and its contributors are not liable for losses arising from your use of the service, including trading losses, failed transactions or third-party failures.</p>

      <h2>7. Fees</h2>
      <p>PinTool does not currently charge its own fees. A Strategy Provider may set a performance fee, shown on each listing as a share of the Maker&apos;s profit; it applies only when the Maker makes a profit. Network gas and protocol fees may apply to your transactions.</p>

      <h2>8. Changes</h2>
      <p>We may update these terms. Continued use after an update means you accept the new terms.</p>
    </>
  );
}
