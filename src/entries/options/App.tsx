export default function OptionsApp() {
  return (
    <div>
      <h1>Virtual Remote Control - Settings</h1>

      <div style={{ marginBottom: '16px' }}>
        <strong>Screenshots</strong>
        <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
          Screenshots are saved as JPG files in the Downloads folder.
        </p>
      </div>

      <hr style={{ margin: '24px 0' }} />
      <p style={{ fontSize: '12px', color: '#666' }}>
        <strong>Phase 2 Coming:</strong> WebSocket configuration, ad detection settings, and more
        controls!
      </p>
    </div>
  );
}
