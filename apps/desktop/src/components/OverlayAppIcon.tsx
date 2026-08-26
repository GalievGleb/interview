import skillCueAppIcon from '../../assets/branding/skillcue-app-icon-512.png';

export default function OverlayAppIcon() {
  return (
    <img
      src={skillCueAppIcon}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={26}
      height={26}
      className="h-[26px] w-[26px] rounded-[8px] object-cover"
    />
  );
}
