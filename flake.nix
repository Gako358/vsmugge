{
  description = "vsmugge — attach the mugge chat inside VS Code";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      perSystem =
        { pkgs, ... }:
        let
          vsmugge = pkgs.buildNpmPackage {
            pname = "vsmugge";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-0t22orx5NBW82cKl+7qkn2Gd0f+l1HxV6+mWw/bCK1Q=";
            npmBuildScript = "compile";

            installPhase = ''
              runHook preInstall
              dest="$out/share/vscode/extensions/gako358.mugge"
              mkdir -p "$dest"
              cp -r package.json out LICENSE README.org "$dest/"
              runHook postInstall
            '';

            passthru = {
              vscodeExtPublisher = "gako358";
              vscodeExtName = "mugge";
              vscodeExtUniqueId = "gako358.mugge";
            };
          };
        in
        {
          packages = {
            inherit vsmugge;
            default = vsmugge;
          };

          formatter = pkgs.nixfmt;

          checks = {
            inherit vsmugge;
          };
        };
    };
}
