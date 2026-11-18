using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Vitals.Setup;

/// <summary>Vitals Setup: Welcome, Options, Installing and Finish, like a standard Windows installer.</summary>
public partial class SetupWindow : Window
{
    private enum Page { Welcome, Options, Installing, Finish, Failed }

    private readonly Installer _installer;
    private readonly SetupChoices _defaults;
    private readonly Task<ClaudeCheck> _claude = Task.Run(ClaudeCheck.Run);
    private readonly Action<string> _log;
    private Page _page = Page.Welcome;
    private TextBlock? _currentStep;

    /// <summary>0 when Vitals was installed, 1 when Setup failed, 2 when it was cancelled.</summary>
    public int Result { get; private set; } = 2;

    public SetupWindow(SetupChoices defaults, bool testMode, Action<string> log)
    {
        _defaults = defaults;
        _log = log;
        InitializeComponent();
        Icon = IconArt.WindowIcon();
        if (testMode) Title += " (test mode)";
        WelcomeIcon.Source = FinishIcon.Source = IconArt.Image(72);
        OptionsIcon.Source = InstallingIcon.Source = IconArt.Image(40);
        string version = "VERSION " + (Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "");
        WelcomeVersion.Text = FinishVersion.Text = version;
        StartWithWindows.IsChecked = defaults.StartWithWindows;
        InstallPath.Text = $"Installs to {Installer.InstallDir}";
        if (Installer.IsUpdate)
        {
            WelcomeAdmin.Text = "Setup updates the Vitals already installed for your Windows account, and keeps your settings.";
            FinishTitle.Text = "Vitals is updated";
        }

        _installer = new Installer
        {
            TestMode = testMode,
            Log = log,
            StepStarted = text => Dispatcher.Invoke(() => AddStep(text)),
            AdminPrompt = showing => Dispatcher.Invoke(() => AdminNote.Visibility = showing ? Visibility.Visible : Visibility.Collapsed),
        };

        NextButton.Click += (_, _) => Next();
        BackButton.Click += (_, _) => Show(Page.Welcome);
        CancelButton.Click += (_, _) => Close();
        Closing += OnClosing;
        TaskbarLink.Click += (_, _) => Open("ms-settings:taskbar");
        PawnIoLink.Click += (_, _) => Open("https://pawnio.eu");
        _ = ShowClaudeCheckAsync();
    }

    private async Task ShowClaudeCheckAsync()
    {
        var check = await _claude;
        _log(check.Message);
        if (check.Available)
        {
            ClaudeLevels.IsEnabled = true;
            ClaudeLevels.IsChecked = _defaults.ClaudeLevels;
            ClaudeHelp.Text = "Claude Code looks up how your CPU and GPU normally run and picks when their temperatures turn amber " +
                              "and red. It runs once for each new chip and uses a little of your Claude plan.";
        }
        else
        {
            ClaudeLevels.IsChecked = false;
            ClaudeLabel.Foreground = new SolidColorBrush(Color.FromRgb(0x9A, 0x9A, 0x9A));
            ClaudeHelp.Text = check.Message;
        }
    }

    private void Show(Page page)
    {
        _page = page;
        WelcomePage.Visibility = page == Page.Welcome ? Visibility.Visible : Visibility.Collapsed;
        OptionsPage.Visibility = page == Page.Options ? Visibility.Visible : Visibility.Collapsed;
        InstallingPage.Visibility = page is Page.Installing or Page.Failed ? Visibility.Visible : Visibility.Collapsed;
        FinishPage.Visibility = page == Page.Finish ? Visibility.Visible : Visibility.Collapsed;
        BackButton.IsEnabled = page == Page.Options;
        NextButton.Content = page switch { Page.Options => "Install", Page.Finish => "Finish", Page.Failed => "Close", _ => "Next >" };
        NextButton.IsEnabled = page != Page.Installing;
        CancelButton.IsEnabled = page is Page.Welcome or Page.Options;
        NextButton.Focus();
    }

    private void Next()
    {
        switch (_page)
        {
            case Page.Welcome: Show(Page.Options); break;
            case Page.Options: _ = InstallAsync(); break;
            case Page.Finish:
            case Page.Failed: Close(); break;
        }
    }

    private async Task InstallAsync()
    {
        Show(Page.Installing);
        var check = await _claude; // the Install button can come before the check ends
        var choices = new SetupChoices(StartWithWindows.IsChecked == true, check.Available && ClaudeLevels.IsChecked == true);
        _log($"Choices: Start with Windows {(choices.StartWithWindows ? "on" : "off")}, Claude Code picks the levels: " +
             (check.Available ? (choices.ClaudeLevels ? "yes" : "no") : "not installed"));
        try
        {
            await Task.Run(() => _installer.Run(choices, check.Available));
        }
        catch (Exception ex)
        {
            string message = ex is SetupException ? ex.Message : $"Something went wrong: {ex.Message}";
            _log("FAILED: " + message);
            MarkCurrentStep(failed: true);
            InstallingTitle.Text = "Setup couldn't finish";
            InstallingSub.Text = "Nothing else was changed after the step that failed.";
            ErrorText.Text = message;
            ErrorNote.Visibility = Visibility.Visible;
            Result = 1;
            Show(Page.Failed);
            return;
        }
        MarkCurrentStep(failed: false);
        Progress.Value = Progress.Maximum;
        if (_installer.StartWithWindowsProblem is string problem)
        {
            FinishNoteText.Text = $"Start with Windows is {(_installer.StartWithWindowsOn ? "on" : "off")}: {problem}. Change it any time in Vitals' Settings.";
            FinishNote.Visibility = Visibility.Visible;
        }
        Result = 0;
        Show(Page.Finish);
    }

    private void AddStep(string text)
    {
        MarkCurrentStep(failed: false);
        Progress.Value = Steps.Children.Count;
        _currentStep = new TextBlock { FontSize = 12, Margin = new Thickness(0, 0, 0, 5), FontWeight = FontWeights.SemiBold };
        _currentStep.Inlines.Add(new System.Windows.Documents.Run("•  ") { Foreground = (Brush)FindResource("Accent") });
        _currentStep.Inlines.Add(new System.Windows.Documents.Run(text + "..."));
        Steps.Children.Add(_currentStep);
    }

    private void MarkCurrentStep(bool failed)
    {
        if (_currentStep == null) return;
        var text = ((System.Windows.Documents.Run)_currentStep.Inlines.LastInline).Text.TrimEnd('.');
        _currentStep.Inlines.Clear();
        _currentStep.Inlines.Add(new System.Windows.Documents.Run(failed ? "✕  " : "✓  ")
            { Foreground = new SolidColorBrush(failed ? Color.FromRgb(0xC4, 0x2B, 0x1C) : Color.FromRgb(0x0F, 0x7B, 0x0F)), FontWeight = FontWeights.Bold });
        _currentStep.Inlines.Add(new System.Windows.Documents.Run(text));
        _currentStep.FontWeight = FontWeights.Normal;
        _currentStep.Foreground = failed ? Brushes.Black : (Brush)FindResource("Ink2");
        _currentStep = null;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        switch (_page)
        {
            case Page.Installing:
                e.Cancel = true; // can't stop halfway
                break;
            case Page.Welcome:
            case Page.Options:
                var answer = MessageBox.Show(this, "Vitals isn't installed yet. Exit Setup?", "Vitals Setup",
                                             MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No);
                if (answer != MessageBoxResult.Yes) e.Cancel = true;
                else _log("Setup was cancelled.");
                break;
            case Page.Finish:
                try { _installer.Finish(StartNow.IsChecked == true); }
                catch (Exception ex) { _log($"Couldn't start Vitals: {ex.Message}"); }
                break;
        }
    }

    private static void Open(string target)
    {
        try { using var _ = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); } catch { }
    }
}
