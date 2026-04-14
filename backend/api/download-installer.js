export function downloadInstallerHandler(_req, res) {
  const installerUrl = 'https://github.com/TranslateGenie/Software/releases/latest/download/mdas-installer.exe';

  return res.status(200).json({
    ok: true,
    installer_url: installerUrl,
    filename: 'mdas-installer.exe',
    notes: 'Replace INSTALLER_URL with a signed installer artifact URL from your release pipeline.',
  });
}
