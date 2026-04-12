export function downloadInstallerHandler(_req, res) {
  const installerUrl = process.env.INSTALLER_URL || 'https://example.com/downloads/mdas-installer.exe';

  return res.status(200).json({
    ok: true,
    installer_url: installerUrl,
    filename: 'mdas-installer.exe',
    notes: 'Replace INSTALLER_URL with a signed installer artifact URL from your release pipeline.',
  });
}
