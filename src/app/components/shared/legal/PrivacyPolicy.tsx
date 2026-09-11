// Describes what the current app actually does; update it when TEE submission or a backend is added.
export default function PrivacyPolicy() {
  return (
    <>
      <p>This policy explains what information PinTool handles when you use the Strategy Provider and Maker experience, and how it is used.</p>

      <h2>1. Information we collect</h2>
      <ul>
        <li><strong>Login details.</strong> Sign-in is provided by Privy. Depending on how you log in, Privy processes your email address or your wallet address. PinTool receives your account identifier and public wallet address.</li>
        <li><strong>Public wallet activity.</strong> Transactions you sign, such as approving tokens or activating an Aqua strategy, are recorded on a public blockchain.</li>
        <li><strong>Profile details.</strong> The photo, display name, bio and X handle you add on your profile are saved in your own browser. If you publish a strategy, your name and photo appear on that listing.</li>
        <li><strong>Strategy listings.</strong> When you publish a strategy, its name and public description are saved in your own browser so Makers on this device can see it.</li>
      </ul>
      <p>We <strong>never</strong> collect or store your private keys or seed phrases.</p>

      <h2>2. Private strategy logic and Maker limits</h2>
      <p>In the current version, the private logic you write in Provider Studio stays in your browser tab and is discarded when you publish. The limits you enter as a Maker are saved with your proposal in your own browser. Neither is sent to PinTool servers. When confidential evaluation is enabled, these inputs will be sent encrypted to a confidential workflow, and this policy will be updated before that happens.</p>

      <h2>3. How we use information</h2>
      <ul>
        <li>To sign you in and show your Providing and Making activity.</li>
        <li>To build the strategy parameters and transactions you choose to sign.</li>
      </ul>
      <p>We do not sell your information and we do not use analytics or advertising trackers.</p>

      <h2>4. Third parties</h2>
      <p>PinTool relies on services that process data under their own policies: Privy for authentication, blockchain RPC providers for reading and sending transactions, and protocols such as 1inch Aqua and Chainlink when you use features built on them.</p>

      <h2>5. Your choices</h2>
      <ul>
        <li>You can log out at any time from your profile.</li>
        <li>You can clear strategy listings by clearing this site&apos;s data in your browser.</li>
        <li>Onchain transactions cannot be deleted by PinTool or anyone else.</li>
      </ul>

      <h2>6. Changes to this policy</h2>
      <p>We will update this page when the product changes how information is handled, and change the date above.</p>

      <h2>7. Contact</h2>
      <p>Questions about this policy: reach us on X at <a href="https://x.com/PinToolX" target="_blank" rel="noopener noreferrer">@PinToolX</a>.</p>
    </>
  );
}
